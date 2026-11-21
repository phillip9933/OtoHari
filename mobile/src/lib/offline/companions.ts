import { Capacitor } from '@capacitor/core';
import { nativeMedia } from './nativeMedia';
import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { albumTracks, localSong, path } from '../catalog/catalog';
import { getJson, postJson, type Session } from '../connection';
import type { PlayerTrack } from '../player';
import { retainedTrack, type OfflineAccount } from './tracks';
import { confirmedFeedback, feedbackRows, feedbackScope } from './feedbackStore';

export async function companion(owner: OfflineAccount, kind: 'artwork' | 'lyrics', key: string) {
	if (!['android', 'ios'].includes(Capacitor.getPlatform()) || !owner.userId) return;
	return (
		await nativeMedia.companion({ serverUrl: owner.serverUrl, userId: owner.userId, kind, key })
	).source;
}

async function refreshIPhone(
	session: Session,
	account: { serverUrl: string; userId: string },
	observed: Set<string>,
	signal?: AbortSignal
) {
	const { targets } = await nativeMedia.metadataTargets(account);
	const remaining = new Map(targets.map((t) => [t.id, t]));
	let updated = 0;
	const confirmed: Record<string, { rating?: number; favorite?: boolean }> = {};
	async function apply(tracks: PlayerTrack[]) {
		const matches = tracks.filter((t) => remaining.has(t.id));
		for (let i = 0; i < matches.length; i += 100) {
			signal?.throwIfAborted();
			const batch = matches.slice(i, i + 100);
			const scores = await postJson<components['schemas']['RatingLookupResponse']>(
				session,
				path('/api/v3/ratings/lookup'),
				{ track_ids: batch.map((t) => t.id) },
				signal
			).catch(() => undefined);
			signal?.throwIfAborted();
			const updates = batch.map((track) => ({
				version: remaining.get(track.id)!.version,
				track: retainedTrack(
					{ ...track, ...(scores?.tracks ? { rating: scores.tracks[track.id] ?? 0 } : {}) },
					account.serverUrl
				)
			}));
			const transferId = crypto.randomUUID();
			const stop = () =>
				void nativeMedia.cancelTransfer({ ...account, transferId }).catch(() => {});
			signal?.addEventListener('abort', stop, { once: true });
			let committed: Set<string>;
			try {
				const result = await nativeMedia.applyMetadata({
					...account,
					token: session.token,
					updates,
					transferId
				});
				signal?.throwIfAborted();
				committed = new Set(result.updated);
			} finally {
				signal?.removeEventListener('abort', stop);
			}
			for (const { track } of updates) {
				remaining.delete(track.id);
				if (committed.has(track.id) && observed.has(track.id))
					confirmed[track.id] = { rating: track.rating, favorite: track.favorite };
			}
			updated += committed.size;
		}
	}
	const albums = new Set(targets.map((t) => t.album).filter(Boolean));
	if (albums.size <= 16)
		for (const localId of albums) {
			signal?.throwIfAborted();
			await apply(await albumTracks(session, { localId, title: '', artist: '' }, signal));
		}
	let after: string | undefined;
	const seen = new Set<string>();
	while (remaining.size) {
		signal?.throwIfAborted();
		const page: components['schemas']['TrackListPage'] = await getJson(
			session,
			path('/api/v3/library/tracks', {}, { limit: 200, after, sort: 'title', order: 'asc' }),
			signal
		);
		await apply(page.items.map((t) => localSong(t)));
		if (!page.next) break;
		if (seen.has(page.next)) throw Error('DN repeated a library page during refresh.');
		seen.add(page.next);
		after = page.next;
	}
	return { updated, unavailable: remaining.size, confirmed };
}

export async function refreshOfflineMetadata(owner: Session, signal?: AbortSignal) {
	if (!owner.userId) throw Error('Reconnect to refresh saved music.');
	const account = { serverUrl: owner.serverUrl, userId: owner.userId },
		scope = feedbackScope(owner);
	const observed = (await feedbackRows(scope)).filter((row) => row.state === 'confirmed');
	const result =
		Capacitor.getPlatform() === 'ios'
			? await refreshIPhone(owner, account, new Set(observed.map((r) => r.id)), signal)
			: await nativeMedia.refreshMetadata({
					...account,
					observedIds: [...new Set(observed.map((row) => row.id))]
				});
	for (const row of observed) {
		const value = result.confirmed?.[row.id]?.[row.field];
		if (typeof value === 'number' || typeof value === 'boolean')
			await confirmedFeedback(scope, row.id, row.field, value, row);
	}
	window.dispatchEvent(new Event('dn-offline-media'));
	return result;
}
