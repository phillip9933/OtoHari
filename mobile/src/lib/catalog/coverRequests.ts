import { getArtwork, type Session } from '../connection';
import { cachedValue, storeValue } from '../offline/viewedMedia';
import { companion } from '../offline/companions';
import { mediaChanged, preferredOffline } from '../offline/media';

// Capacitor's native transport does not share the browser's per-host request pool.
const pending = new WeakMap<Session, Map<string, CoverRequest>>();
const waiting = new Set<CoverRequest>();
type CoverRequest = {
	start: () => Promise<void>;
	listeners: Set<(source: string) => void>;
	source?: string;
	settled?: boolean;
};
const freshFor = 7 * 24 * 60 * 60 * 1000;
let offlineModes = new WeakMap<Session, Promise<boolean>>();
window.addEventListener(mediaChanged, () => {
	offlineModes = new WeakMap();
});
function offlineOnly(session: Session) {
	const pending = offlineModes.get(session);
	if (pending) return pending;
	const mode = preferredOffline(session).catch(() => false);
	offlineModes.set(session, mode);
	return mode;
}
let running = 0;
function drain() {
	for (const request of waiting) {
		if (running >= 4) break;
		waiting.delete(request);
		running++;
		void request.start().finally(() => {
			running--;
			drain();
		});
	}
}

export function observeCover(
	session: Session,
	path: string,
	receive: (source: string) => void,
	cacheOnly = false
) {
	const key = cacheOnly ? 'offline:' + path : path;
	const entries = pending.get(session) ?? new Map<string, CoverRequest>();
	pending.set(session, entries);
	let request = entries.get(key);
	if (!request) {
		const listeners = new Set<(source: string) => void>();
		const job: CoverRequest = {
			listeners,
			start: async () => {
				let reusable = false;
				try {
					const cached = await cachedValue(session, 'artwork', path).catch(() => undefined);
					if (cached?.source) {
						job.source = cached.source;
						for (const listener of listeners) listener(cached.source);
						if (Date.now() - (cached.fetched ?? 0) < freshFor) {
							reusable = true;
							return;
						}
					}
					if (!cached?.source && listeners.size) {
						const saved = await companion(session, 'artwork', path).catch(() => undefined);
						if (saved) {
							job.source = saved;
							reusable = true;
							for (const listener of listeners) listener(saved);
							return;
						}
					}
					if (cacheOnly || !navigator.onLine || !listeners.size || (await offlineOnly(session)))
						return;
					const source = await getArtwork(session, path);
					job.source = source;
					reusable = true;
					for (const listener of listeners) listener(source);
					if (cached) await storeValue(session, 'artwork', path, source, cached.revision);
				} catch {
					// Cover keeps its local artwork placeholder when the server has no image.
				} finally {
					job.settled = true;
					// A player and its palette can subscribe at different times to
					// the same visible cover, even if persistent caching is off.
					if (!reusable || !listeners.size) entries.delete(key);
				}
			}
		};
		request = job;
		entries.set(key, request);
		waiting.add(request);
	}
	request.listeners.add(receive);
	if (request.source) receive(request.source);
	drain();
	return () => {
		request.listeners.delete(receive);
		if (
			!request.listeners.size &&
			(waiting.delete(request) || request.settled) &&
			entries.get(key) === request
		)
			entries.delete(key);
	};
}
