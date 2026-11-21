import { rememberPinnedPlaylists } from '../catalog/playlistOffline';
import { resolveCollections } from './resolveCollections';
import { refreshPinRules } from './collectionPins';
import { Capacitor } from '@capacitor/core';
import { tr } from '../i18n';
import { combineSignals } from '../abortSignals';
import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { DnError, getJson, postJson, type Session } from '../connection';
import { localSong, path } from '../catalog/catalog';
import { readPlaylist } from '../catalog/playlists';
import { inventory } from './library';
import { overlayFeedback } from './feedbackStore';
import type { PlayerAccess, PlayerTrack } from '../player';
import {
	retainedTrack,
	playlistId,
	type DownloadSource,
	type PlaylistSource,
	type OfflineAccount,
	type OfflineOptions,
	type OfflineSnapshot
} from './tracks';
export {
	cacheSizes,
	offlineDefaults,
	type OfflineItem,
	type OfflineOptions,
	type OfflineSnapshot
} from './tracks';
import { audioNotFound, webOffline } from './web';
import { nativeMedia } from './nativeMedia';

export const offlineSupported =
	['ios', 'android'].includes(Capacitor.getPlatform()) || !Capacitor.isNativePlatform();
export const nativeOffline = ['ios', 'android'].includes(Capacitor.getPlatform());
const backend = () => (nativeOffline ? nativeMedia : webOffline);
export const mediaChanged = 'dn-offline-media';
let activeBatches = 0;

function account(session: OfflineAccount) {
	if (!offlineSupported) throw Error('Offline music is unavailable on this platform.');
	if (!session.userId) throw Error('Reconnect to DN once to identify your offline library.');
	return { serverUrl: session.serverUrl, userId: session.userId };
}
export async function offlineSnapshot(session: OfflineAccount): Promise<OfflineSnapshot> {
	const state = await backend().snapshot(account(session));
	if (state.pinnedPlaylists?.length) rememberPinnedPlaylists(session, state.pinnedPlaylists);
	return { ...state, items: await overlayFeedback(session, state.items).catch(() => state.items) };
}
export async function offlineInventory(session: OfflineAccount) {
	return inventory(await offlineSnapshot(session));
}
export function watchOfflineMedia(listener: () => void) {
	const update = () => {
		if (!activeBatches) listener();
	};
	window.addEventListener(mediaChanged, update);
	const nativeListener = nativeOffline ? nativeMedia.addListener('mediaChanged', update) : null;
	return () => {
		window.removeEventListener(mediaChanged, update);
		void nativeListener?.then((handle) => handle.remove());
	};
}
export async function preferredOffline(session: OfflineAccount) {
	if (!offlineSupported || !session.userId) return false;
	return (await backend().options(account(session))).offlineOnly;
}
export async function configureOffline(
	session: OfflineAccount,
	options: OfflineOptions,
	clearUnpinned = false
) {
	const existing = await backend().options(account(session));
	const next = await backend().configure({ ...account(session), options, clearUnpinned });
	if (
		existing.autoDownload !== next.autoDownload ||
		JSON.stringify(existing.offlinePins) !== JSON.stringify(next.offlinePins) ||
		existing.offlineOnly !== next.offlineOnly ||
		existing.downloadMiB !== next.downloadMiB ||
		existing.unmeteredOnly !== next.unmeteredOnly
	)
		await stopAutoDownloads(session);
	if (existing.offlineOnly !== next.offlineOnly)
		window.dispatchEvent(new Event('dn-offline-policy'));
	window.dispatchEvent(new Event(mediaChanged));
	return next;
}
export async function clearPlaylistDownloads(session: OfflineAccount, source: PlaylistSource) {
	const key = syncKey(session),
		previous = syncs.get(key);
	const result = await backend().clearAutomaticPlaylist({ ...account(session), source });
	if (previous && syncs.get(key) === previous) {
		syncs.delete(key);
		previous.abort.abort();
	}
	window.dispatchEvent(new Event(mediaChanged));
	return result;
}
export async function clearAutomatic(session: OfflineAccount) {
	await backend().clearCache(account(session));
	window.dispatchEvent(new Event(mediaChanged));
}
export async function removeOffline(session: OfflineAccount, ids: string[]) {
	await backend().remove({ ...account(session), ids });
	window.dispatchEvent(new Event(mediaChanged));
}
async function withRatings(session: PlayerAccess, tracks: PlayerTrack[]) {
	if (!tracks.length || !navigator.onLine) return tracks;
	try {
		const ratings = await postJson<components['schemas']['RatingLookupResponse']>(
			{ displayName: '', ...session },
			path('/api/v3/ratings/lookup'),
			{ track_ids: tracks.map((t) => t.id) }
		);
		if (!ratings?.tracks || typeof ratings.tracks !== 'object') return tracks;
		return tracks.map((t) => ({ ...t, rating: ratings.tracks[t.id] ?? 0 }));
	} catch {
		return tracks;
	}
}
export async function stopIPhoneDownloads(session: OfflineAccount) {
	if (Capacitor.getPlatform() === 'ios' && session.userId)
		await nativeMedia.disconnectDownloads(account(session));
}

async function saveTrack(input: Parameters<typeof nativeMedia.save>[0], signal?: AbortSignal) {
	signal?.throwIfAborted();
	if (Capacitor.getPlatform() !== 'ios')
		return backend().save({ ...input, ...(!nativeOffline ? { signal } : {}) });
	const transferId = crypto.randomUUID();
	const stop = () =>
		void nativeMedia
			.cancelTransfer({ serverUrl: input.serverUrl, userId: input.userId, transferId })
			.catch(() => {});
	signal?.addEventListener('abort', stop, { once: true });
	try {
		await nativeMedia.save({ ...input, transferId });
		signal?.throwIfAborted();
	} finally {
		signal?.removeEventListener('abort', stop);
	}
}
export async function saveOfflineTracks(
	session: PlayerAccess & OfflineAccount,
	tracks: PlayerTrack[],
	onprogress?: (complete: number, total: number) => void,
	signal?: AbortSignal
) {
	const owner = account(session);
	const unique = [...new Map(tracks.map((t) => [t.id, t])).values()];
	signal?.throwIfAborted();
	if (nativeOffline && unique.length) {
		const result = await nativeMedia.enqueueManual({
			...owner,
			...(Capacitor.getPlatform() === 'ios' ? { token: session.token } : {}),
			tracks: unique.map((track) => retainedTrack(track, owner.serverUrl))
		});
		const { saved, queued, alreadyQueued, failed } = result;
		const count = (n: number) => n.toLocaleString() + (n === 1 ? ' song' : ' songs');
		const message = [
			saved && tr(count(saved) + ' saved offline.', saved + ' 曲をオフライン用に保存しました。'),
			queued &&
				tr(
					count(queued) + ' queued for download.',
					queued + ' 曲をダウンロードキューに追加しました。'
				),
			alreadyQueued &&
				tr(
					count(alreadyQueued) + ' already in the download queue.',
					alreadyQueued + ' 曲はすでにダウンロード待ちです。'
				),
			failed &&
				tr(count(failed) + ' could not be saved. ', failed + ' 曲を保存できませんでした。') +
					result.status.lastError
		]
			.filter(Boolean)
			.join(' ');
		return { saved, queued: queued + alreadyQueued, failed, message };
	}
	let saved = 0,
		failed = 0,
		lastError = '';
	activeBatches++;
	try {
		const options = await backend().options(owner);
		for (let start = 0; start < unique.length; start += 100) {
			signal?.throwIfAborted();
			const batch = unique.slice(start, start + 100);
			for (const track of options.offlineOnly ? batch : await withRatings(session, batch)) {
				signal?.throwIfAborted();
				try {
					await saveTrack(
						{
							...owner,
							token: session.token,
							track: retainedTrack(track, session.serverUrl)
						},
						signal
					);
					saved++;
				} catch (e) {
					signal?.throwIfAborted();
					failed++;
					lastError =
						e instanceof Error
							? e.message
							: tr('Download failed.', 'ダウンロードできませんでした。');
				}
				onprogress?.(saved + failed, unique.length);
			}
		}
	} finally {
		if (--activeBatches === 0) window.dispatchEvent(new Event(mediaChanged));
	}
	const success = tr(
		saved + (saved === 1 ? ' song saved offline.' : ' songs saved offline.'),
		saved + ' 曲をオフライン用に保存しました。'
	);
	return {
		saved,
		queued: 0,
		failed,
		message: failed
			? (saved ? success + ' ' : '') +
				tr(failed + ' failed. ', failed + ' 曲を保存できませんでした。') +
				lastError
			: success
	};
}
const syncs = new Map<string, { pending: Promise<number>; abort: AbortController }>();
const syncKey = (a: OfflineAccount) => JSON.stringify([a.serverUrl, a.userId]);
export async function stopAutoDownloads(session: OfflineAccount) {
	const key = syncKey(session),
		job = syncs.get(key);
	if (!job) return;
	syncs.delete(key);
	job.abort.abort();
	if (session.userId) await backend().cancelAutomatic(account(session));
}

const playlistIssues = new WeakMap<Session, { source: DownloadSource; message: string }>();
export function playlistSyncIssue(session: Session, source: DownloadSource) {
	const issue = playlistIssues.get(session);
	return issue?.source === source ? issue.message : '';
}
function setPlaylistIssue(session: Session, source: DownloadSource, message: string) {
	if (message) playlistIssues.set(session, { source, message });
	else playlistIssues.delete(session);
	window.dispatchEvent(new Event('dn-playlist-sync'));
}

async function automaticSelection(
	session: Session,
	source: Exclude<DownloadSource, 'off'>,
	signal?: AbortSignal
) {
	if (source === 'recent' || source === 'favorites') {
		const response = await getJson<components['schemas']['TrackListPage']>(
			session,
			path(
				'/api/v3/library/tracks',
				{},
				{
					limit: 25,
					sort: 'date_added',
					order: 'desc',
					favorites: source === 'favorites' ? 'true' : undefined
				}
			),
			signal
		);
		return { tracks: response.items.slice(0, 25).map((t) => localSong(t)), keepExisting: false };
	}
	const id = playlistId(source);
	if (!id) throw Error('Choose a valid DN playlist.');
	try {
		const detail = await readPlaylist(session, { id }, signal, true);
		signal?.throwIfAborted();
		setPlaylistIssue(
			session,
			source,
			detail.keepExisting
				? 'Some entries have no confirmed local file. Existing automatic copies were kept.'
				: ''
		);
		return detail;
	} catch (cause) {
		signal?.throwIfAborted();
		const message =
			cause instanceof DnError && [403, 404].includes(cause.status)
				? 'This playlist was deleted or you no longer have access. Existing automatic copies were kept.'
				: 'Could not confirm the complete playlist with DN. Existing automatic copies were kept.';
		setPlaylistIssue(session, source, message);
		throw Error(message, { cause });
	}
}

export function runAutoDownloads(session: Session, signal?: AbortSignal): Promise<number> {
	if (signal?.aborted || !offlineSupported || !session.userId || !navigator.onLine)
		return Promise.resolve(0);
	const key = syncKey(session);
	const previous = syncs.get(key);
	if (previous) return previous.pending;
	const abort = new AbortController();
	signal = signal ? combineSignals(signal, abort.signal) : abort.signal;
	const pending = sync().finally(() => {
		// Release the listeners linking this completed batch to the signed-in session.
		abort.abort();
		if (syncs.get(key)?.pending === pending) syncs.delete(key);
	});
	syncs.set(key, { pending, abort });
	return pending;
	async function sync() {
		const owner = account(session);
		if (Capacitor.getPlatform() === 'ios')
			await nativeMedia.resumeManual({ ...owner, token: session.token });
		const settings = await backend().options(owner);
		const source = settings.autoDownload;
		if (settings.offlineOnly || signal?.aborted) return 0;
		if (
			Capacitor.getPlatform() === 'android' &&
			(settings.offlinePins?.length || source !== 'off')
		) {
			const updated = refreshPinRules(session, settings.offlinePins ?? []);
			if (JSON.stringify(updated) !== JSON.stringify(settings.offlinePins ?? []))
				await nativeMedia.configure({ ...owner, options: { ...settings, offlinePins: updated } });
			signal?.throwIfAborted();
			const result = await nativeMedia.syncCollections(owner);
			signal?.throwIfAborted();
			setPlaylistIssue(session, source, result.message ?? '');
			return result.saved;
		}
		if (Capacitor.getPlatform() === 'ios' && settings.offlinePins?.length) {
			if (!(await nativeMedia.canSyncCollections(owner)).permitted) return 0;
			const configured = refreshPinRules(session, settings.offlinePins);
			if (JSON.stringify(configured) !== JSON.stringify(settings.offlinePins))
				await nativeMedia.configure({
					...owner,
					options: { ...settings, offlinePins: configured }
				});
			const pins = [...configured];
			const legacy = playlistId(source);
			if (legacy && !pins.some((p) => p.kind === 'playlist' && p.id === legacy))
				pins.unshift({ kind: 'playlist', id: legacy, name: 'DN playlist' });
			if ((source === 'recent' || source === 'favorites') && !pins.some((p) => p.kind === source))
				pins.unshift({ kind: source, id: source, name: source });
			const resolved = await resolveCollections(session, pins, signal!);
			signal?.throwIfAborted();
			const { ids } = await nativeMedia.planCollections({
				...owner,
				pins: configured,
				source,
				members: resolved.members
			});
			let missing = 0;
			const partial = resolved.members.filter((member) => !member.complete);
			setPlaylistIssue(
				session,
				source,
				partial.length
					? 'Could not confirm every collection with DN. Existing automatic copies were kept.'
					: ''
			);
			activeBatches++;
			try {
				const disappeared = await resolved.visit(ids, async (tracks) => {
					for (const track of await withRatings(session, tracks)) {
						signal?.throwIfAborted();
						try {
							await saveTrack(
								{
									...owner,
									token: session.token,
									track: retainedTrack(track, session.serverUrl),
									collection: true
								},
								signal
							);
						} catch (error) {
							if (!(error instanceof Error && 'code' in error && error.code === audioNotFound))
								throw error;
							missing++;
						}
					}
				});
				missing += disappeared;
			} finally {
				if (--activeBatches === 0) window.dispatchEvent(new Event(mediaChanged));
			}
			if (missing)
				setPlaylistIssue(
					session,
					source,
					[
						playlistSyncIssue(session, source),
						tr(
							'Some pinned audio is unavailable. The next update will retry.',
							'一部のピン留めした曲を取得できません。次回の更新時に再試行します。'
						)
					]
						.filter(Boolean)
						.join(' ')
				);
			if (!ids.length) return 0;
			const wanted = new Set(ids);
			return (await nativeMedia.snapshot(owner)).items.filter(
				(row) => row.origin === 'automatic' && wanted.has(row.track.id)
			).length;
		}
		if (!source || source === 'off') return 0;
		const { tracks, keepExisting } = await automaticSelection(session, source, signal);
		signal?.throwIfAborted();
		const byId = new Map<string, PlayerTrack>();
		for (const track of tracks) if (!byId.has(track.id)) byId.set(track.id, track);
		const { ids } = await backend().planAutomatic({
			...owner,
			source,
			ids: [...byId.keys()],
			keepExisting
		});
		const wanted = new Set(ids);
		const eligible = [...byId.values()].filter((t) => wanted.has(t.id));
		const playlist = source.startsWith('playlist:');
		const names: string[] = [];
		let missing = 0;
		activeBatches++;
		try {
			for (let start = 0; start < eligible.length && navigator.onLine; start += 100) {
				signal?.throwIfAborted();
				for (const track of await withRatings(session, eligible.slice(start, start + 100))) {
					signal?.throwIfAborted();
					if (!navigator.onLine) break;
					try {
						await saveTrack(
							{
								...owner,
								token: session.token,
								track: retainedTrack(track, session.serverUrl),
								source
							},
							signal
						);
					} catch (cause) {
						signal?.throwIfAborted();
						if (
							!playlist ||
							!cause ||
							typeof cause !== 'object' ||
							!('code' in cause) ||
							cause.code !== audioNotFound
						)
							throw cause;
						missing++;
						if (names.length < 3) {
							const title = track.title.trim().slice(0, 96) || 'Untitled track';
							const artist = track.artist.trim().slice(0, 64);
							names.push('“' + title + '”' + (artist ? ' by ' + artist : ''));
						}
					}
				}
			}
		} finally {
			if (missing && !signal?.aborted) {
				const remainder = missing - names.length;
				const list = names.join(', ') + (remainder ? ' and ' + remainder + ' more' : '');
				const summary =
					'DN could not find the original audio for ' +
					list +
					'. The next update will retry ' +
					(missing === 1 ? 'this song.' : 'these ' + missing + ' songs.');
				setPlaylistIssue(
					session,
					source,
					[playlistSyncIssue(session, source), summary].filter(Boolean).join(' ')
				);
			}
			if (--activeBatches === 0) window.dispatchEvent(new Event(mediaChanged));
		}
		if (!wanted.size) return 0;
		const snapshot = await backend().snapshot(owner);
		return snapshot.items.filter((item) => wanted.has(item.track.id) && item.origin === 'automatic')
			.length;
	}
}
export function storageSize(bytes: number) {
	if (!bytes) return '0 B';
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1048576) return Math.ceil(bytes / 1024) + ' KiB';
	if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MiB';
	return (bytes / 1073741824).toFixed(1) + ' GiB';
}
