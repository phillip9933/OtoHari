import { audioBlob, maxAudioBlobBytes } from '../player/audioTransfer';
import type { PlayerTrack } from '../player';
import { combineSignals } from '../abortSignals';
import {
	cacheSizes,
	playlistId,
	validDownloadSource,
	validLocalFileId,
	type PlaylistSource,
	offlineDefaults,
	retainedTrack,
	type DownloadSource,
	type OfflineItem,
	type OfflineOrigin,
	type OfflineOptions,
	type OfflineSnapshot
} from './tracks';

type Account = { serverUrl: string; userId: string };
type Entry = Omit<OfflineItem, 'origin'> & {
	origin?: OfflineOrigin;
	scope: string;
	id: string;
	audio: Blob;
};
type EnabledSource = Exclude<DownloadSource, 'off'>;
const originOf = (item: Entry): OfflineOrigin =>
	item.origin ?? (item.pinned ? 'downloaded' : 'cached');
function complete(item: Entry | undefined): item is Entry {
	return !!item && item.bytes > 0 && item.bytes === item.audio?.size;
}
export const audioNotFound = 'DN_AUDIO_NOT_FOUND';
export interface OfflineBridge {
	snapshot(a: Account): Promise<OfflineSnapshot>;
	options(a: Account): Promise<OfflineOptions>;
	configure(
		a: Account & { options: OfflineOptions; clearUnpinned?: boolean }
	): Promise<OfflineOptions>;
	clearCache(a: Account): Promise<void>;
	remove(a: Account & { ids: string[] }): Promise<void>;
	cancelAutomatic(a: Account): Promise<void>;
	clearAutomaticPlaylist(a: Account & { source: PlaylistSource }): Promise<OfflineOptions>;
	planAutomatic(
		a: Account & { source: EnabledSource; ids: string[]; keepExisting?: boolean }
	): Promise<{ ids: string[] }>;
	save(
		a: Account & { token: string; track: PlayerTrack; source?: EnabledSource; signal?: AbortSignal }
	): Promise<void>;
}
const scope = (a: Account) => JSON.stringify([a.serverUrl, a.userId]);
let opened: Promise<IDBDatabase> | undefined;
function database() {
	if (!opened)
		opened = new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('dn.mobile.offline.v1', 1);
			req.onupgradeneeded = () => {
				req.result
					.createObjectStore('tracks', { keyPath: ['scope', 'id'] })
					.createIndex('scope', 'scope');
				req.result.createObjectStore('options');
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => {
				opened = undefined;
				reject(req.error);
			};
		});
	return opened;
}
function result<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((ok, bad) => {
		req.onsuccess = () => ok(req.result);
		req.onerror = () => bad(req.error);
	});
}
async function transaction<T>(
	mode: IDBTransactionMode,
	operation: (tracks: IDBObjectStore, prefs: IDBObjectStore) => Promise<T>
) {
	const tx = (await database()).transaction(['tracks', 'options'], mode);
	const complete = new Promise<void>((ok, bad) => {
		tx.oncomplete = () => ok();
		tx.onabort = () => bad(tx.error ?? Error('Offline storage write failed.'));
	});
	try {
		const out = await operation(tx.objectStore('tracks'), tx.objectStore('options'));
		await complete;
		return out;
	} catch (e) {
		try {
			tx.abort();
		} catch {
			/* A failed request can already have ended the transaction. */
		}
		await complete.catch(() => {});
		throw e;
	}
}
async function rows(store: IDBObjectStore, key: string): Promise<Entry[]> {
	return result(store.index('scope').getAll(IDBKeyRange.only(key)));
}
async function bump(store: IDBObjectStore, marker: IDBValidKey) {
	await result(store.put(((await result(store.get(marker))) ?? 0) + 1, marker));
}
async function prefs(store: IDBObjectStore, key: string): Promise<OfflineOptions> {
	return { ...offlineDefaults, ...(await result(store.get(key))) };
}
async function trim(store: IDBObjectStore, key: string, origin: OfflineOrigin, limit: number) {
	const automatic = (await rows(store, key))
		.filter((t) => originOf(t) === origin)
		.sort((a, b) => b.used - a.used);
	let total = 0;
	for (const t of automatic) {
		if (total + t.bytes <= limit) total += t.bytes;
		else store.delete([key, t.id]);
	}
}
type Revision = { cache: number; automatic: number; item: number };
async function revision(store: IDBObjectStore, key: string, id: string): Promise<Revision> {
	return {
		cache: (await result(store.get(['cache', key]))) ?? 0,
		automatic: (await result(store.get(['automatic', key]))) ?? 0,
		item: (await result(store.get(['item', key, id]))) ?? 0
	};
}
export async function webPlaybackPolicy(a: Account, id: string) {
	const key = scope(a);
	return transaction('readonly', async (_, settings) => ({
		options: await prefs(settings, key),
		revision: await revision(settings, key, id)
	}));
}
async function automaticRoom(
	store: IDBObjectStore,
	key: string,
	added: number,
	options: OfflineOptions
) {
	const used = (await rows(store, key)).reduce(
		(n, item) => n + (originOf(item) === 'automatic' ? item.bytes : 0),
		0
	);
	const available = Math.max(0, options.downloadMiB * 1048576 - used);
	if (added > available) throw Error('The automatic download limit has been reached.');
	return available;
}

async function write(
	a: Account,
	track: PlayerTrack,
	audio: Blob,
	origin: OfflineOrigin,
	started: Revision,
	source?: EnabledSource
) {
	const key = scope(a);
	await transaction('readwrite', async (store, settings) => {
		const existing: Entry | undefined = await result(store.get([key, track.id]));
		const current = await revision(settings, key, track.id);
		if (current.item !== started.item) throw Error('The offline copy was removed.');
		const opts = await prefs(settings, key);
		if (
			origin === 'cached' &&
			(current.cache !== started.cache || !opts.autoCache || audio.size > opts.cacheMiB * 1048576)
		)
			return;
		if (
			origin === 'automatic' &&
			(current.automatic !== started.automatic || opts.autoDownload !== source || opts.offlineOnly)
		)
			throw Error('The automatic download settings changed.');
		if (
			complete(existing) &&
			(origin === 'cached' ||
				originOf(existing) === 'downloaded' ||
				(origin === 'automatic' && originOf(existing) === 'automatic'))
		)
			return;
		if (origin === 'automatic') await automaticRoom(store, key, audio.size, opts);
		if (!audio.size) throw Error('The audio download was incomplete.');
		await result(
			store.put({
				scope: key,
				id: track.id,
				track: retainedTrack(track, a.serverUrl),
				audio,
				origin,
				pinned: origin === 'downloaded',
				bytes: audio.size,
				used: Date.now()
			} satisfies Entry)
		);
		if (origin === 'cached') await trim(store, key, 'cached', opts.cacheMiB * 1048576);
		if (origin === 'downloaded') await result(settings.delete(['exclude', key, track.id]));
	});
}
export async function webLocalAudio(a: Account, id: string) {
	return transaction('readwrite', async (store) => {
		const entry: Entry | undefined = await result(store.get([scope(a), id]));
		if (!complete(entry)) return null;
		entry.used = Date.now();
		await result(store.put(entry));
		return { blob: entry.audio, source: originOf(entry) };
	});
}
export async function cacheWebPlayback(
	a: Account,
	track: PlayerTrack,
	audio: Blob,
	started: Revision
) {
	try {
		await write(a, track, audio, 'cached', started);
		window.dispatchEvent(new Event('dn-offline-media'));
	} catch {
		/* Optional caching must not interrupt playback if storage is full. */
	}
}
export const webOffline: OfflineBridge = {
	async snapshot(a) {
		const key = scope(a);
		return transaction('readonly', async (store, settings) => ({
			options: await prefs(settings, key),
			items: (await rows(store, key))
				.filter(complete)
				.map((e) => ({
					track: e.track,
					bytes: e.bytes,
					used: e.used,
					origin: originOf(e),
					pinned: originOf(e) === 'downloaded'
				}))
				.sort((a, b) => b.used - a.used)
		}));
	},
	async options(a) {
		return transaction('readonly', async (_, settings) => prefs(settings, scope(a)));
	},
	async configure(a) {
		if (
			!cacheSizes.includes(a.options.cacheMiB) ||
			!cacheSizes.includes(a.options.downloadMiB) ||
			!validDownloadSource(a.options.autoDownload)
		)
			throw Error('Choose a supported download source and storage limit.');
		const key = scope(a);
		return transaction('readwrite', async (store, settings) => {
			const old = await prefs(settings, key);
			if ((!a.options.autoCache && old.autoCache) || (a.options.offlineOnly && !old.offlineOnly))
				await bump(settings, ['cache', key]);
			if (old.autoDownload !== a.options.autoDownload || old.offlineOnly !== a.options.offlineOnly)
				await bump(settings, ['automatic', key]);
			await result(settings.put(a.options, key));
			await trim(store, key, 'cached', a.options.cacheMiB * 1048576);
			await trim(store, key, 'automatic', a.options.downloadMiB * 1048576);
			return a.options;
		});
	},
	async remove(a) {
		const key = scope(a);
		await transaction('readwrite', async (store, settings) => {
			for (const id of a.ids) {
				await bump(settings, ['item', key, id]);
				await result(settings.put(true, ['exclude', key, id]));
				await result(store.delete([key, id]));
			}
		});
	},
	async clearCache(a) {
		const key = scope(a);
		await transaction('readwrite', async (store, settings) => {
			await bump(settings, ['cache', key]);
			await trim(store, key, 'cached', 0);
		});
	},
	async cancelAutomatic(a) {
		await transaction('readwrite', (_, settings) => bump(settings, ['automatic', scope(a)]));
	},
	async clearAutomaticPlaylist(a) {
		const key = scope(a);
		return transaction('readwrite', async (store, settings) => {
			const old = await prefs(settings, key);
			if (!playlistId(a.source) || old.autoDownload !== a.source)
				throw Error('The selected playlist changed.');
			await bump(settings, ['automatic', key]);
			for (const entry of await rows(store, key)) {
				if (originOf(entry) !== 'automatic') continue;
				await bump(settings, ['item', key, entry.id]);
				await result(store.delete([key, entry.id]));
			}
			const next: OfflineOptions = { ...old, autoDownload: 'off' };
			await result(settings.put(next, key));
			return next;
		});
	},
	async planAutomatic(a) {
		const key = scope(a);
		return transaction('readwrite', async (store, settings) => {
			const options = await prefs(settings, key);
			if (
				options.autoDownload === 'off' ||
				a.source !== options.autoDownload ||
				options.offlineOnly
			)
				return { ids: [] };
			if (
				!validDownloadSource(a.source) ||
				!Array.isArray(a.ids) ||
				(a.keepExisting !== undefined && typeof a.keepExisting !== 'boolean')
			)
				throw Error('DN returned an incomplete song list.');
			const wanted = new Set<string>();
			for (const id of playlistId(a.source) ? a.ids : a.ids.slice(0, 25)) {
				if (!validLocalFileId(id)) throw Error('DN returned an invalid library song.');
				wanted.add(id);
			}
			const eligible = new Set(wanted);
			for (const entry of await rows(store, key)) {
				if (!complete(entry)) continue;
				const origin = originOf(entry);
				if (origin === 'automatic' && !a.keepExisting && !wanted.has(entry.id)) {
					await bump(settings, ['item', key, entry.id]);
					await result(store.delete([key, entry.id]));
				}
				if (origin !== 'cached') eligible.delete(entry.id);
			}
			const ids: string[] = [];
			for (const id of eligible)
				if (!(await result(settings.get(['exclude', key, id])))) ids.push(id);
			return { ids };
		});
	},
	async save(a) {
		const key = scope(a);
		const started = await transaction('readwrite', async (store, settings) => {
			const cached: Entry | undefined = await result(store.get([key, a.track.id]));
			const options = await prefs(settings, key);
			if (
				a.source &&
				(options.autoDownload !== a.source ||
					options.offlineOnly ||
					(await result(settings.get(['exclude', key, a.track.id]))))
			)
				return null;
			if (!complete(cached)) {
				if (options.offlineOnly)
					throw Error('Turn off offline-only playback to download new songs.');
				return {
					revision: await revision(settings, key, a.track.id),
					limit: a.source
						? Math.min(maxAudioBlobBytes, await automaticRoom(store, key, 0, options))
						: maxAudioBlobBytes
				};
			}
			if (a.source && originOf(cached) !== 'cached') return null;
			if (a.source) await automaticRoom(store, key, cached.bytes, options);
			cached.origin = a.source ? 'automatic' : 'downloaded';
			cached.pinned = !a.source;
			cached.used = Date.now();
			cached.track = {
				...cached.track,
				...Object.fromEntries(
					Object.entries(retainedTrack(a.track, a.serverUrl)).filter(([, v]) => v !== undefined)
				)
			};
			await result(store.put(cached));
			if (!a.source) await result(settings.delete(['exclude', key, a.track.id]));
			return null;
		});
		if (!started) return;
		if (!navigator.onLine) throw Error('Reconnect to download this song.');
		const source = new URL(a.serverUrl + a.track.streamUrl);
		source.searchParams.set('format', 'raw');
		const response = await fetch(source, {
			headers: { Authorization: 'Bearer ' + a.token },
			credentials: 'omit',
			redirect: 'error',
			cache: 'no-store',
			referrerPolicy: 'no-referrer',
			signal: a.signal
				? combineSignals(a.signal, AbortSignal.timeout(180000))
				: AbortSignal.timeout(180000)
		});
		if (a.source?.startsWith('playlist:') && (response.status === 404 || response.status === 410))
			throw Object.assign(Error('DN could not find this audio file.'), { code: audioNotFound });
		if (response.status !== 200 || !isAudio(response.headers.get('content-type')))
			throw Error('DN could not serve this audio file.');
		const blob = await audioBlob(response, undefined, started.limit);
		const expected = response.headers.get('content-length');
		if (
			!blob.size ||
			(expected && !response.headers.get('content-encoding') && Number(expected) !== blob.size)
		)
			throw Error('The audio download was incomplete.');
		await write(
			a,
			a.track,
			blob,
			a.source ? 'automatic' : 'downloaded',
			started.revision,
			a.source
		);
	}
};
export function isAudio(value: string | null) {
	const mime = value?.split(';')[0].trim().toLowerCase();
	return (
		!!mime &&
		(mime.startsWith('audio/') ||
			['application/octet-stream', 'application/ogg', 'application/flac'].includes(mime))
	);
}
