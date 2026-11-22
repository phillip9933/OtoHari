import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { getJson, putJson, postJson, type Session } from '../connection';
import { radioSong, cover, path, playerTrack, type Album } from './catalog';
import { validLocalFileId } from '../offline/tracks';

import { artistArtwork } from './artistArtwork';

type Schema = components['schemas'];
export type DiscoverArtistRef = { id: string; name: string; localOnly?: boolean };
export type DiscoverView = 'popular' | 'trending' | 'top' | 'following' | 'releases' | 'concerts';
export type ChartRange = Schema['StatsRange'];
type Artist = { name: string; target?: DiscoverArtistRef; art?: string; fallbackArt?: string };
export type Shelf = { title: string; albums: Album[]; artists: Artist[]; unlinked: string[] };
export type DiscoveryPage = {
	shelves: Shelf[];
	concerts?: Schema['Concert'][];
	notice?: string;
	next?: number;
	refreshing?: boolean;
};

export function createShelf(title: string): Shelf {
	return { title, albums: [], artists: [], unlinked: [] };
}

export function addArtist(list: Shelf, row: Schema['ArtistRef']) {
	const id = row.musicbrainz_id || row.local_id;
	const target = id ? { id, name: row.name, localOnly: !row.musicbrainz_id } : undefined;
	if (list.artists.some((a) => (id ? a.target?.id === id : a.name === row.name))) return;
	list.artists.push({ name: row.name, target, ...artistArtwork(row.musicbrainz_id, row.local_id) });
}

export function addAlbum(list: Shelf, row: Schema['AlbumRef']) {
	const group = row.musicbrainz_id,
		localId = row.local_id;
	if (!group && !localId) {
		list.unlinked.push([row.title, row.artist_name].filter(Boolean).join(' · '));
		return;
	}
	if (list.albums.some((a) => (a.localId || a.group) === (localId || group))) return;
	list.albums.push({
		group,
		localId,
		title: row.title,
		artist: row.artist_name ?? '',
		year: row.year,
		requested: row.requested,
		art: cover(group, localId)
	});
}

export async function discover(
	session: Session,
	view: DiscoverView,
	range: ChartRange,
	offset: number,
	limit = 24
): Promise<DiscoveryPage> {
	const query = { range, offset, limit };
	switch (view) {
		case 'top':
		case 'popular': {
			const url = view === 'top' ? '/api/v3/home/your-top/albums' : '/api/v3/home/popular/albums';
			const result = await getJson<Schema['ChartPage_AlbumRef']>(session, path(url, {}, query));
			const list = createShelf('');
			result.items.forEach((row) => addAlbum(list, row));
			return {
				shelves: [list],
				next: result.has_more && result.limit > 0 ? result.offset + result.limit : undefined
			};
		}
		case 'trending': {
			const result = await getJson<Schema['ChartPage_ArtistRef']>(
				session,
				path('/api/v3/home/trending/artists', {}, query)
			);
			const list = createShelf('');
			result.items.forEach((row) => addArtist(list, row));
			return {
				shelves: [list],
				next: result.has_more && result.limit > 0 ? result.offset + result.limit : undefined
			};
		}
		case 'following': {
			const result = await getJson<Schema['FollowedArtistListResponse']>(
				session,
				path('/api/v3/following/artists')
			);
			const list = createShelf('');
			result.artists.forEach((a) =>
				addArtist(list, { name: a.name, musicbrainz_id: a.artist_mbid, in_library: false })
			);
			return { shelves: [list] };
		}
		case 'releases': {
			const result = await getJson<Schema['NewReleaseListResponse']>(
				session,
				path(
					'/api/v3/following/new-releases/recent',
					{},
					{ days: 90, include_owned: 'true', limit: 100 }
				)
			);
			const list = createShelf('');
			result.items.forEach((r) =>
				addAlbum(list, {
					musicbrainz_id: r.release_group_mbid,
					title: r.title,
					artist_name: r.artist_name,
					in_library: r.in_library,
					requested: false,
					release_date: r.first_release_date,
					year: r.first_release_date
						? Number(r.first_release_date.slice(0, 4)) || undefined
						: undefined
				})
			);
			return { shelves: [list] };
		}
		case 'concerts': {
			const result = await getJson<Schema['ConcertsResponse']>(
				session,
				path('/api/v3/following/concerts')
			);
			return {
				shelves: [],
				concerts: result.items,
				notice: result.configured
					? undefined
					: 'Concert listings are not configured on this server.'
			};
		}
	}
}

export type ReleaseType = 'all' | 'albums' | 'eps' | 'singles';
export async function artistReleases(
	session: Session,
	artist: DiscoverArtistRef,
	offset: number,
	cursor?: string,
	type: ReleaseType = 'all',
	signal?: AbortSignal
) {
	if (artist.localOnly) {
		const result = await getJson<Schema['AlbumPage']>(
			session,
			path('/api/v3/library/albums', {}, { artist_id: artist.id, limit: 24, after: cursor }),
			signal
		);
		const albums: Album[] = result.items.map((a) => ({
			title: a.title,
			artist: a.artist_name,
			group: a.release_group_mbid,
			localId: a.id,
			year: a.year,
			art: cover(a.release_group_mbid, a.id, a.art_missing)
		}));
		return { albums, next: undefined, cursor: result.next, warming: false };
	}
	const list = createShelf('');
	// DN pages the three release types together. Advance through empty pages when a type is selected.
	for (;;) {
		const result = await getJson<Schema['ArtistReleases']>(
			session,
			path(
				'/api/v3/artists/{artist_mbid}/releases',
				{ artist_mbid: artist.id },
				{ offset, limit: type === 'all' ? 24 : 100 }
			),
			signal
		);
		const releases =
			type === 'all' ? [...result.albums, ...result.eps, ...result.singles] : result[type];
		for (const r of releases) {
			if (r.title)
				addAlbum(list, {
					title: r.title,
					artist_name: artist.name,
					year: r.year,
					musicbrainz_id: r.id,
					in_library: r.in_library,
					requested: r.requested
				});
		}
		const next =
			result.has_more && result.next_offset != null && result.next_offset > offset
				? result.next_offset
				: undefined;
		if (list.albums.length || next === undefined || type === 'all')
			return { albums: list.albums, next, cursor: undefined, warming: result.warming };
		offset = next;
	}
}

export function followStatus(session: Session, artist: string) {
	return getJson<Schema['FollowStatusResponse']>(
		session,
		path('/api/v3/artists/{artist_mbid}/follow-status', { artist_mbid: artist })
	);
}
export function follow(session: Session, artist: string, followed: boolean) {
	return putJson<Schema['FollowStatusResponse']>(
		session,
		path('/api/v3/artists/{artist_mbid}/follow', { artist_mbid: artist }),
		{ followed } satisfies Schema['FollowBody']
	);
}

export async function browseGenre(session: Session, name: string, offset: number) {
	const limit = 24;
	const result = await getJson<Schema['GenreDetailResponse']>(
		session,
		path(
			'/api/v3/home/genre/{genre_name}',
			{ genre_name: name },
			{ limit, artist_offset: offset, album_offset: offset }
		)
	);
	const lists: Shelf[] = [];
	function albumsAndArtists(
		rows: Schema['GenrePopularSection'] | Schema['GenreLibrarySection'],
		title: string
	) {
		const list = createShelf(title);
		rows.albums.forEach((a) => addAlbum(list, a));
		rows.artists.forEach((a) => addArtist(list, a));
		if (rows.albums.length || rows.artists.length) lists.push(list);
	}
	if (result.library && !offset) albumsAndArtists(result.library, 'In your library');
	if (result.popular) albumsAndArtists(result.popular, 'Popular');
	return {
		lists,
		limit,
		more: result.popular?.has_more_artists || result.popular?.has_more_albums
	};
}

function chartNotice(page: Schema['TopAlbumsResponse'] | Schema['TopSongsResponse']) {
	if (page.needs_account.length)
		return 'Link a listening account in DroppedNeedle to see this chart.';
	if (!page.configured) return 'Your server has no listening service configured for this chart.';
	if (page.unavailable_sources.length) return 'The listening service is currently unavailable.';
	return '';
}
export async function artistChart(
	session: Session,
	artist: DiscoverArtistRef,
	view: 'albums' | 'songs'
) {
	const params = { artist_mbid: artist.id };
	const query = { count: 20 };
	if (view === 'albums') {
		const page = await getJson<Schema['TopAlbumsResponse']>(
			session,
			path('/api/v3/artists/{artist_mbid}/top-albums', params, query)
		);
		const list = createShelf('');
		page.albums.forEach((a) => addAlbum(list, a));
		return { list, notice: chartNotice(page) };
	}
	const page = await getJson<Schema['TopSongsResponse']>(
		session,
		path('/api/v3/artists/{artist_mbid}/top-songs', params, query)
	);
	const positions = page.songs.flatMap((s) =>
		s.release_group_mbid && s.track_number != null
			? [
					{
						release_group_mbid: s.release_group_mbid,
						disc_number: s.disc_number ?? 1,
						track_number: s.track_number
					}
				]
			: []
	);
	const resolved = positions.length
		? await postJson<Schema['ResolveTracksResponse']>(
				session,
				path('/api/v3/library/resolve-tracks'),
				{ items: positions } satisfies Schema['ResolveTracksRequest']
			)
		: { items: [] };
	const queue: ReturnType<typeof playerTrack>[] = [];
	const songs = page.songs.map((song) => {
		const file = resolved.items.find(
			(i) =>
				i.source === 'local' &&
				i.release_group_mbid === song.release_group_mbid &&
				i.track_number === song.track_number &&
				(i.disc_number ?? 1) === (song.disc_number ?? 1)
		);
		const index = file?.track_source_id ? queue.length : null;
		if (file?.track_source_id)
			queue.push(
				playerTrack(
					file.track_source_id,
					song.title,
					song.artist_name,
					song.release_name ?? '',
					cover(song.release_group_mbid),
					file.duration
				)
			);
		return { song, index };
	});
	return { songs, queue, notice: chartNotice(page) };
}

export type RadioSeed = Extract<Schema['RadioSeedKind'], 'artist' | 'genre' | 'album'>;
export async function libraryPlan(
	session: Session,
	seed: Pick<Schema['RadioPlanRequest'], 'seed_type' | 'seed_id' | 'items'>,
	signal?: AbortSignal
) {
	const plan = await postJson<Schema['RadioPlanResponse']>(
		session,
		path('/api/v3/discover/radio/plan'),
		{
			...seed,
			mode: 'library',
			count: 25
		} satisfies Schema['RadioPlanRequest'],
		signal
	);
	const seen = new Set<string>();
	return plan.tracks.flatMap((t) => {
		const id = t.local_file_id;
		if (!t.in_library || !validLocalFileId(id) || seen.has(id)) return [];
		seen.add(id);
		return [radioSong(t, id)];
	});
}
export function libraryRadio(
	session: Session,
	seedType: RadioSeed,
	seedId: string,
	signal?: AbortSignal
) {
	return libraryPlan(session, { seed_type: seedType, seed_id: seedId }, signal);
}
