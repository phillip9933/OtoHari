import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import type { PlayerTrack } from '../player';
import { tr, uiText } from '../i18n';
import { getJson, type Session } from '../connection';
import { albumTracks, localAlbum, localSong, path, type Album } from './catalog';
import { playlistArtwork, playlists, readPlaylist, type Playlist } from './playlists';
import { prepareLibraryQueue } from './libraryQueue';
import { readSmartPlaylists, smartPlaylistTracks, type SmartPlaylist } from './smartPlaylists';
import {
	requestFilters,
	matchesDeviceTrack,
	deviceTrackOrder,
	type BrowseFilters
} from './trackFilters';
export { requestFilters, type BrowseFilters } from './trackFilters';
import { rememberAlbumCounts } from './albumTrackCounts';
import { offlinePlaylists } from './playlistOffline';
import { readLibraryGenres, tracksInGenre, displayTag } from './libraryGenres';

import { artistArtwork } from './artistArtwork';

type Schema = components['schemas'];
export const categories = ['Playlists', 'Artists', 'Albums', 'Tracks', 'Genres'] as const;
export type Category = (typeof categories)[number];
export type BrowseItem = {
	fallbackArt?: string;
	id: string;
	title: string;
	subtitle?: string;
	art?: string;
	covers?: string[];
	album?: Album;
	artist?: Schema['ArtistView'];
	playlist?: Playlist;
	smart?: SmartPlaylist;
	track?: PlayerTrack;
	genre?: string;
	localTracks?: PlayerTrack[];
	available?: PlayerTrack[];
	count?: number;
	knownPlayable?: number;
	year?: number;
	added?: number;
};
export type BrowsePage = { items: BrowseItem[]; total?: number; next?: string | null };
function albumCount(count: number) {
	if (!Number.isFinite(count)) return undefined;
	return tr(count + (count === 1 ? ' album' : ' albums'), count.toLocaleString() + '枚のアルバム');
}
export const defaultSort: Record<Category, string> = {
	Playlists: 'name',
	Artists: 'name',
	Albums: 'name',
	Tracks: 'title',
	Genres: 'name'
};
export const orderChoices: Record<Category, readonly (readonly [string, string])[]> = {
	Playlists: [
		['name', 'Title'],
		['count', 'Track count']
	],
	Artists: [
		['name', 'Artist name'],
		['album_count', 'Album count'],
		['date_added', 'Recently added']
	],
	Albums: [
		['name', 'Album title'],
		['artist', 'Artist'],
		['date_added', 'Recently added'],
		['year', 'Year']
	],
	Tracks: [
		['title', 'Track title'],
		['artist', 'Artist'],
		['album', 'Album'],
		['date_added', 'Recently added']
	],
	Genres: [
		['name', 'Name'],
		['count', 'Track count']
	]
};
export function trackItem(track: PlayerTrack): BrowseItem {
	return {
		id: 'track:' + track.id,
		title: track.title,
		subtitle: [track.artist, track.year].filter(Boolean).join(' · '),
		track,
		art: track.artworkUrl,
		year: track.year,
		added: track.dateAdded
	};
}
export function playlistItem(p: Playlist): BrowseItem {
	return {
		id: 'playlist:' + p.id,
		title: p.name,
		count: p.track_count,
		get subtitle() {
			if (!Number.isFinite(p.track_count)) return undefined;
			return tr(
				p.track_count + (p.track_count === 1 ? ' track' : ' tracks'),
				p.track_count.toLocaleString() + '曲'
			);
		},
		covers: playlistArtwork(p),
		playlist: p
	};
}
export function albumItem(album: Album): BrowseItem {
	return {
		id: 'album:' + (album.localId || album.group),
		title: album.title,
		subtitle: album.artist,
		art: album.art,
		album
	};
}
export function trackOccurrences(tracks: PlayerTrack[]) {
	const occurrences = new Map<string, number>();
	return tracks.map((track) => {
		const occurrence = (occurrences.get(track.id) ?? 0) + 1;
		occurrences.set(track.id, occurrence);
		return { ...trackItem(track), id: JSON.stringify([track.id, occurrence]) };
	});
}
export function browseChoice(session: Session, item: BrowseItem) {
	return {
		id: item.id,
		title: item.title,
		tracks: (signal: AbortSignal, forQueue: boolean) => resolveItem(session, item, signal, forQueue)
	};
}
export async function resolveItem(
	session: Session,
	item: BrowseItem,
	signal: AbortSignal,
	forQueue: boolean
): Promise<PlayerTrack[]> {
	if (item.localTracks) return item.localTracks;
	if (item.track) return [item.track];
	if (item.album) return albumTracks(session, item.album, signal);
	if (item.artist)
		return prepareLibraryQueue(
			session,
			{ artist_id: item.artist.id, sort: 'album', order: 'asc' },
			signal,
			undefined,
			forQueue
		);
	if (item.playlist) return (await readPlaylist(session, item.playlist, signal)).tracks;
	if (item.smart) return smartPlaylistTracks(session, item.smart, signal, item.available);
	if (item.genre !== undefined) return tracksInGenre(session, item.genre, signal, forQueue);
	return [];
}
function sorted(items: BrowseItem[], f: BrowseFilters) {
	const query = f.q.trim().toLocaleLowerCase();
	const by = (row: BrowseItem): string | number => {
		if (f.sort === 'count' || f.sort === 'album_count') return row.count ?? 0;
		if (f.sort === 'year') return row.year ?? 0;
		if (f.sort === 'date_added') return row.added ?? 0;
		if (f.sort === 'artist') return row.track?.artist ?? row.album?.artist ?? row.subtitle ?? '';
		if (f.sort === 'album') return row.track?.album ?? row.title;
		return row.title;
	};
	const compare = (a: BrowseItem, b: BrowseItem) => {
		const left = by(a),
			right = by(b);
		const order =
			typeof left === 'number' && typeof right === 'number'
				? left - right
				: String(left).localeCompare(String(right), undefined, {
						sensitivity: 'base',
						numeric: true
					});
		return (
			(f.order === 'desc' ? -1 : 1) *
			(order || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
		);
	};
	return items
		.filter(
			(s) => !query || [s.title, s.subtitle].some((x) => x?.toLocaleLowerCase().includes(query))
		)
		.sort(compare);
}
export function localAlbumKey(track: PlayerTrack) {
	return (
		track.albumId ||
		JSON.stringify([
			track.album || 'Unknown album',
			track.albumArtist || track.artist || 'Unknown artist'
		])
	);
}
export type DeviceCollection = { category: 'Albums' | 'Playlists'; filters: BrowseFilters };
export function localBrowse(
	category: Category,
	tracks: PlayerTrack[],
	f: BrowseFilters
): BrowseItem[] {
	const filtered = tracks.filter((t) =>
		matchesDeviceTrack(t, category === 'Tracks' ? f : { ...f, q: '' })
	);
	if (category === 'Tracks') return filtered.sort(deviceTrackOrder(f)).map(trackItem);
	const groups = new Map<string, BrowseItem>();
	function group(key: string, title: string, track: PlayerTrack, subtitle?: string) {
		const id = category + ':' + key;
		const item: BrowseItem = groups.get(id) ?? {
			id,
			title,
			get subtitle() {
				return category === 'Artists' ? albumCount(this.count ?? 0) : subtitle;
			},
			art: track.artworkUrl,
			localTracks: [],
			year: track.year,
			added: track.dateAdded
		};
		if (category === 'Genres' && title) item.title = displayTag(item.title, title);
		item.localTracks!.push(track);
		item.count = item.localTracks!.length;
		item.added = Math.max(item.added ?? 0, track.dateAdded ?? 0);
		groups.set(id, item);
	}
	for (const t of filtered) {
		const artist = t.albumArtist || t.artist;
		const displayArtist = artist || tr('Unknown artist', '不明なアーティスト');
		if (category === 'Artists') {
			const key =
				t.albumArtistId ||
				(t.albumArtist && t.albumArtist !== t.artist ? artist : t.artistId) ||
				artist ||
				'Unknown artist';
			group(key, displayArtist, t);
			if (t.artist && t.artist.toLocaleLowerCase() !== artist.toLocaleLowerCase()) {
				const credited = t.artistId || t.artist;
				if (credited !== key) group(credited, t.artist, t);
			}
		} else if (category === 'Albums') {
			const title = t.album || tr('Unknown album', '不明なアルバム');
			group(localAlbumKey(t), title, t, displayArtist);
		} else if (category === 'Genres') {
			const title = t.genre?.trim() || '';
			group(title.toLocaleLowerCase(), title || tr('Missing genre', 'ジャンル未設定'), t);
		}
	}
	for (const a of groups.values())
		if (category === 'Artists') {
			a.count = new Set(a.localTracks!.map((t) => t.albumId || t.album)).size;
		}
	for (const group of groups.values())
		group.localTracks?.sort(deviceTrackOrder({ ...f, sort: 'album', order: 'asc' }));
	return sorted([...groups.values()], f);
}
export function localPage(items: BrowseItem[], after?: string | null, size = 48): BrowsePage {
	const start = Number(after) || 0,
		end = start + size;
	return {
		items: items.slice(start, end),
		total: items.length,
		next: end < items.length ? String(end) : null
	};
}
export type BrowseSnapshot = { items?: BrowseItem[] };
export async function browsePage(
	session: Session,
	category: Category,
	filters: BrowseFilters,
	after: string | null,
	signal: AbortSignal,
	available?: PlayerTrack[],
	progress?: (n: number, total: number) => void,
	snapshot?: BrowseSnapshot,
	pageSize?: number
): Promise<BrowsePage> {
	if (snapshot?.items) return localPage(snapshot.items, after, pageSize);
	const present = (all: BrowseItem[]) => {
		if (snapshot) snapshot.items = all;
		return localPage(all, after, pageSize);
	};
	if (available && category !== 'Playlists')
		return present(localBrowse(category, available, filters));
	const params = { ...requestFilters(filters), limit: pageSize ?? 30, after: after ?? undefined };
	if (category === 'Albums') {
		const p = await getJson<Schema['AlbumPage']>(
			session,
			path('/api/v3/library/albums', {}, params),
			signal
		);
		await rememberAlbumCounts(session, p.items);
		return {
			...p,
			items: p.items.map((a) => albumItem(localAlbum(a)))
		};
	}
	if (category === 'Artists') {
		const p = await getJson<Schema['ArtistPage']>(
			session,
			path('/api/v3/library/artists', {}, params),
			signal
		);
		return {
			...p,
			items: p.items.map((a) => ({
				id: 'artist:' + a.id,
				title: a.name,
				get subtitle() {
					return albumCount(a.album_count);
				},
				...artistArtwork(a.artist_mbid, a.id, a.art_missing),
				artist: a
			}))
		};
	}
	if (category === 'Tracks') {
		const p = await getJson<Schema['TrackListPage']>(
			session,
			path('/api/v3/library/tracks', {}, params),
			signal
		);
		return { ...p, items: p.items.map((t) => trackItem(localSong(t))) };
	}
	if (category === 'Genres') {
		const labels = await readLibraryGenres(session, signal, progress);
		return present(
			sorted(
				labels.map(([genre, count]) => ({
					id: 'genre:' + genre,
					get title() {
						return genre || tr('Missing genre', 'ジャンル未設定');
					},
					genre,
					count
				})),
				filters
			)
		);
	}
	const [regular, smart] = await Promise.all([
		available ? Promise.resolve([]) : playlists(session, signal),
		readSmartPlaylists(session)
	]);
	const all: BrowseItem[] = regular.map(playlistItem);
	if (available) all.push(...offlinePlaylists(session, available));
	for (const rule of smart) {
		signal.throwIfAborted();
		const localTracks = available
			? await smartPlaylistTracks(session, rule, signal, available)
			: undefined;
		if (localTracks && !localTracks.length) continue;
		all.push({
			id: 'smart:' + rule.id,
			title: rule.name,
			get subtitle() {
				return uiText('Smart playlist · on this device');
			},
			smart: rule,
			available,
			localTracks,
			count: localTracks?.length
		});
	}
	return present(sorted(all, filters));
}
