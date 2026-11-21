import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { getJson, type Session } from '../connection';
import { localSong, path } from '../catalog/catalog';
import { readPlaylist } from '../catalog/playlists';
import type { PlayerTrack } from '../player';
import { validLocalFileId, type OfflinePin } from './tracks';

type TrackRow = components['schemas']['TrackView'];
type CatalogRows<T> = { total: number; items: T[]; next?: string | null };
type Group = 'tracks' | 'albums' | 'artists';

async function* pages<T extends { id: string }>(
	session: Session,
	group: Group,
	filters: Record<string, string>,
	signal: AbortSignal,
	top = 0
): AsyncGenerator<T[]> {
	const route = {
		tracks: '/api/v3/library/tracks',
		albums: '/api/v3/library/albums',
		artists: '/api/v3/library/artists'
	} as const;
	const seen = new Set<string>(),
		cursors = new Set<string>();
	let total: number | undefined, after: string | undefined;
	const limit = top || 100;
	do {
		signal.throwIfAborted();
		const page: CatalogRows<T> = await getJson(
			session,
			path(route[group], {}, { ...filters, limit, after }),
			signal
		);
		const changed = () => Error('DN returned an incomplete collection.');
		if (
			!Array.isArray(page.items) ||
			page.items.length > limit ||
			!Number.isSafeInteger(page.total) ||
			page.total < 0 ||
			(total !== undefined && total !== page.total)
		)
			throw changed();
		total = page.total;
		for (const row of page.items) {
			if (!validLocalFileId(row.id) || seen.has(row.id)) throw changed();
			seen.add(row.id);
		}
		if (
			seen.size > total ||
			(page.next == null
				? seen.size !== total
				: !page.items.length ||
					seen.size >= total ||
					typeof page.next !== 'string' ||
					!page.next ||
					cursors.has(page.next))
		)
			throw changed();
		yield page.items;
		if (top && seen.size === top) return;
		after = page.next ?? undefined;
		if (after) cursors.add(after);
	} while (after);
}

export type CollectionMember = {
	kind: OfflinePin['kind'];
	id: string;
	ids: string[];
	complete: boolean;
	name: string;
};
async function readPin(
	session: Session,
	pin: OfflinePin,
	signal: AbortSignal,
	receive: (tracks: PlayerTrack[]) => Promise<void>
) {
	async function tracks(filters: Record<string, string>, top = 0) {
		for await (const rows of pages<TrackRow>(session, 'tracks', filters, signal, top)) {
			if (rows.some((r) => typeof r.title !== 'string')) throw Error('Invalid library track.');
			await receive(rows.map((r) => localSong(r)));
		}
	}
	if (pin.kind === 'playlist') {
		const playlist = await readPlaylist(session, { id: pin.id }, signal, true);
		await receive(playlist.tracks);
		return { name: playlist.playlist.name, complete: !playlist.keepExisting };
	}
	if (pin.kind === 'recent' || pin.kind === 'favorites') {
		await tracks(
			{
				sort: 'date_added',
				order: 'desc',
				...(pin.kind === 'favorites' ? { favorites: 'true' } : {})
			},
			25
		);
	} else if (pin.kind === 'artist') {
		await tracks({ artist_id: pin.id, sort: 'album', order: 'asc' });
	} else if (pin.group === 'songs') {
		await tracks(pin.filters ?? {});
	} else if (pin.group === 'artists' || pin.group === 'albums') {
		const field = pin.group === 'artists' ? 'artist_id' : 'album_id';
		for await (const rows of pages(session, pin.group, pin.filters ?? {}, signal))
			for (const { id } of rows) await tracks({ [field]: id, sort: 'album', order: 'asc' });
	} else throw Error('Unknown library filter.');
	return { name: pin.name, complete: true };
}

// Keep only IDs for large libraries. Re-read metadata in pages if a missing
// file falls outside the first batch of remembered tracks.
export async function resolveCollections(
	session: Session,
	pins: OfflinePin[],
	signal: AbortSignal
) {
	const first = new Map<string, PlayerTrack>();
	const members: CollectionMember[] = [];
	for (const pin of pins) {
		const member: CollectionMember = {
			kind: pin.kind,
			id: pin.id,
			name: pin.name,
			complete: false,
			ids: []
		};
		const seen = new Set<string>();
		try {
			Object.assign(
				member,
				await readPin(session, pin, signal, async (rows) => {
					for (const t of rows) {
						if (!validLocalFileId(t.id)) throw Error('Invalid library track.');
						if (pin.kind === 'playlist' || !seen.has(t.id)) member.ids.push(t.id);
						seen.add(t.id);
						if (first.size < 2000 && !first.has(t.id)) first.set(t.id, t);
					}
				})
			);
		} catch {
			signal.throwIfAborted();
		}
		members.push(member);
	}
	async function visit(ids: string[], receive: (tracks: PlayerTrack[]) => Promise<void>) {
		const pending = new Set(ids);
		async function batch(rows: PlayerTrack[]) {
			const tracks = rows.filter((t) => pending.delete(t.id));
			for (let i = 0; i < tracks.length; i += 100) {
				signal.throwIfAborted();
				await receive(tracks.slice(i, i + 100));
			}
		}
		await batch([...first.values()]);
		for (const [i, pin] of pins.entries()) {
			if (!members[i].ids.some((id) => pending.has(id))) continue;
			await readPin(session, pin, signal, batch);
			if (!pending.size) break;
		}
		return pending.size;
	}
	return { members, visit };
}
