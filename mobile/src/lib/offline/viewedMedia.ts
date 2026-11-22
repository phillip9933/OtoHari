import type { Session } from '../connection';

const mib = 1024 * 1024;
export const mediaLimits = {
	artwork: [0, 32, 64, 128, 256, 512, 1024, 2048, 4096],
	lyrics: [0, 2, 8, 32]
};
export type MediaKind = keyof typeof mediaLimits;
const defaults = { artwork: 64, lyrics: 8 };
const entryLimits = { artwork: 4 * mib, lyrics: mib / 2 };
type Policy = { limit: number; revision: number; bytes: number; count: number };
type Metadata = { scope: string; path: string; used: number; fetched: number; bytes: number };
type Stores = { policy: IDBObjectStore; metadata: IDBObjectStore; payloads: IDBObjectStore };
const initial = (kind: MediaKind): Policy => ({
	limit: defaults[kind],
	revision: 0,
	bytes: 0,
	count: 0
});
let opening: Promise<IDBDatabase> | undefined;

function scopeOf(s: Session, kind: MediaKind) {
	return s.userId ? JSON.stringify([s.serverUrl, s.userId, kind]) : undefined;
}
function open() {
	if (!opening)
		opening = new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('dn.mobile.viewed-media', 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				db.createObjectStore('policy');
				db.createObjectStore('payloads');
				db.createObjectStore('metadata', { keyPath: ['scope', 'path'] }).createIndex('used', [
					'scope',
					'used'
				]);
			};
			req.onsuccess = () => {
				const db = req.result;
				db.onversionchange = () => {
					db.close();
					opening = undefined;
				};
				resolve(db);
			};
			req.onerror = () => reject(req.error);
		}).catch((error) => {
			opening = undefined;
			throw error;
		});
	return opening;
}
function read<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
async function transaction<T>(mode: IDBTransactionMode, operation: (stores: Stores) => Promise<T>) {
	const tx = (await open()).transaction(['policy', 'metadata', 'payloads'], mode);
	const completed = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error('This device’s media cache is unavailable.'));
	});
	try {
		const value = await operation({
			policy: tx.objectStore('policy'),
			metadata: tx.objectStore('metadata'),
			payloads: tx.objectStore('payloads')
		});
		await completed;
		return value;
	} catch (cause) {
		try {
			tx.abort();
		} catch {
			/* The transaction may have already aborted. */
		}
		await completed.catch(() => {});
		throw cause;
	}
}
async function policyAt(store: IDBObjectStore, scope: string, kind: MediaKind): Promise<Policy> {
	return (await read(store.get(scope))) ?? initial(kind);
}

// The index contains only timestamps and IDs, so pruning never decodes the payload being evicted.
function trim(stores: Stores, scope: string, policy: Policy, budget: number) {
	if (policy.bytes <= budget) return Promise.resolve();
	const query = IDBKeyRange.bound([scope, 0], [scope, Number.MAX_SAFE_INTEGER]);
	return new Promise<void>((resolve, reject) => {
		const req = stores.metadata.index('used').openCursor(query);
		req.onerror = () => reject(req.error);
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor || policy.bytes <= budget) {
				resolve();
				return;
			}
			const meta: Metadata = cursor.value;
			stores.payloads.delete(cursor.primaryKey);
			cursor.delete();
			policy.bytes -= meta.bytes;
			policy.count--;
			cursor.continue();
		};
	});
}

export async function cacheUsage(session: Session, kind: MediaKind) {
	const scope = scopeOf(session, kind);
	if (!scope) throw new Error('Reconnect to DN once to identify this device’s media cache.');
	return transaction('readonly', (s) => policyAt(s.policy, scope, kind));
}
export async function setCacheLimit(
	session: Session,
	kind: MediaKind,
	limit: number,
	clear = false
) {
	const scope = scopeOf(session, kind);
	if (!scope || !mediaLimits[kind].includes(limit))
		throw new Error('Choose an available cache limit.');
	await transaction('readwrite', async (s) => {
		const p = await policyAt(s.policy, scope, kind);
		p.limit = limit;
		p.revision++;
		await trim(s, scope, p, clear ? 0 : limit * mib);
		await read(s.policy.put(p, scope));
	});
}
export async function cachedValue(session: Session, kind: MediaKind, path: string) {
	const scope = scopeOf(session, kind);
	if (!scope) return;
	return transaction('readwrite', async (s) => {
		const p = await policyAt(s.policy, scope, kind);
		if (!p.limit) return;
		const key = [scope, path],
			meta: Metadata | undefined = await read(s.metadata.get(key));
		if (!meta) return { revision: p.revision };
		const source: string | undefined = await read(s.payloads.get(key));
		if (!source) return { revision: p.revision };
		meta.used = Date.now();
		await read(s.metadata.put(meta));
		return { revision: p.revision, source, fetched: meta.fetched };
	});
}
export async function storeValue(
	session: Session,
	kind: MediaKind,
	path: string,
	source: string,
	revision: number
) {
	const scope = scopeOf(session, kind);
	if (!scope || !source || source.length > entryLimits[kind]) return false;
	if (kind === 'artwork' && !/^data:image\/(jpeg|png|webp|avif|gif);base64,/i.test(source))
		return false;
	const bytes = kind === 'artwork' ? source.length : new TextEncoder().encode(source).length;
	if (bytes > entryLimits[kind]) return false;
	return transaction('readwrite', async (s) => {
		const p = await policyAt(s.policy, scope, kind);
		if (!p.limit || p.revision !== revision) return false;
		const key = [scope, path],
			previous: Metadata | undefined = await read(s.metadata.get(key));
		const now = Date.now();
		p.bytes += bytes - (previous?.bytes ?? 0);
		if (!previous) p.count++;
		await read(s.payloads.put(source, key));
		await read(s.metadata.put({ scope, path, used: now, fetched: now, bytes } satisfies Metadata));
		await trim(s, scope, p, p.limit * mib);
		await read(s.policy.put(p, scope));
		return true;
	});
}

export async function removeCachedValue(
	session: Session,
	kind: MediaKind,
	path: string,
	revision: number
) {
	const scope = scopeOf(session, kind);
	if (!scope) return;
	await transaction('readwrite', async (s) => {
		const p = await policyAt(s.policy, scope, kind);
		if (p.revision !== revision) return;
		const key = [scope, path];
		const meta: Metadata | undefined = await read(s.metadata.get(key));
		if (!meta) return;
		await read(s.payloads.delete(key));
		await read(s.metadata.delete(key));
		p.bytes -= meta.bytes;
		p.count--;
		await read(s.policy.put(p, scope));
	});
}
