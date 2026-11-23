import { rememberAlbumCounts } from './albumTrackCounts';
import type { components, paths } from '../../../../frontend/src/lib/api/v3/openapi';
import { DnError, getJson, postJson, type Session } from '../connection';
import type { LibraryContinuation } from '../player/libraryWindow';
import type { PlayerTrack } from '../player';

type Schema = components['schemas'];
export type CatalogTab = 'home' | 'library' | 'discover' | 'search' | 'requests';
export type OnPlay = (
	tracks: PlayerTrack[],
	index: number,
	continuation?: LibraryContinuation
) => Promise<void> | void;
export type Edition = Schema['AlbumEditionItem'];
export type RequestItem = Schema['RequestItem'];
export type Album = {
	title: string;
	artist: string;
	year?: number | null;
	localId?: string | null;
	group?: string | null;
	art?: string;
	requested?: boolean;
	release?: string | null;
	imported?: boolean;
	favorite?: boolean;
};

export function path<T extends keyof paths>(
	template: T,
	params: Record<string, string> = {},
	query: Record<string, string | number | undefined> = {}
) {
	const route = template.replace(/\{([^}]+)\}/g, (_, key: string) => {
		if (!params[key]) throw new Error('A DroppedNeedle item is missing its ID.');
		return encodeURIComponent(params[key]);
	});
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) search.set(key, String(value));
	}
	return search.size ? route + '?' + search : route;
}

// Some chart and search rows carry IDs without saying whether the album has its own art.
export function cover(
	group?: string | null,
	localId?: string | null,
	missing = false,
	localAvailable = !group
) {
	if (missing) return undefined;
	if (localId && localAvailable)
		return path('/api/v3/library/albums/{id}/artwork', { id: localId }, { size: 500 });
	if (group)
		return path(
			'/api/v3/covers/release-group/{release_group_id}',
			{ release_group_id: group },
			{ size: 500 }
		);
}

export function playerTrack(
	id: string,
	title: string,
	artist: string,
	album: string,
	art: string | undefined,
	duration?: number | null
): PlayerTrack {
	return {
		id,
		title,
		artist,
		album,
		streamUrl: path('/api/v3/stream/{source}/{*key}', { source: 'local', '*key': id }),
		artworkUrl: art,
		duration: duration ?? undefined
	};
}

export function replayGainTags(
	t: Pick<
		Schema['TrackView'],
		| 'replaygain_track_gain'
		| 'replaygain_album_gain'
		| 'replaygain_track_peak'
		| 'replaygain_album_peak'
	>
) {
	return {
		replayGainTrackDb: t.replaygain_track_gain ?? undefined,
		replayGainAlbumDb: t.replaygain_album_gain ?? undefined,
		replayGainTrackPeak: t.replaygain_track_peak ?? undefined,
		replayGainAlbumPeak: t.replaygain_album_peak ?? undefined
	};
}

export function radioSong(t: Schema['RadioPlanTrack'], id: string): PlayerTrack {
	return {
		...playerTrack(
			id,
			t.track_name,
			t.artist_name,
			t.album_name ?? '',
			cover(t.album_mbid),
			t.duration_s
		),
		...replayGainTags(t),
		artistMbid: t.artist_mbid || undefined,
		recordingMbid: t.recording_mbid || undefined,
		releaseGroupMbid: t.album_mbid || undefined,
		format: t.file_format || undefined
	};
}

export function localAlbum(a: Schema['AlbumView']): Album {
	return {
		title: a.title,
		artist: a.artist_name,
		year: a.year,
		localId: a.id,
		group: a.release_group_mbid,
		favorite: a.favorite,
		art: cover(a.release_group_mbid, a.id, a.art_missing, a.cover_available === true)
	};
}

export function localSong(t: Schema['TrackView'], artist = '') {
	return {
		...playerTrack(
			t.id,
			t.title,
			t.artist_name || artist,
			t.album_title,
			cover(t.release_group_mbid, t.album_id, t.art_missing, t.cover_available === true),
			t.duration_seconds
		),
		albumId: t.album_id || undefined,
		artistId: t.artist_id || undefined,
		artistMbid: t.artist_mbid || t.album_artist_mbid || undefined,
		recordingMbid: t.recording_mbid || undefined,
		releaseGroupMbid: t.release_group_mbid || undefined,
		...replayGainTags(t),
		albumArtist: t.album_artist_name || undefined,
		albumArtistId: t.album_artist_id || undefined,
		genre: t.genre || undefined,
		year: t.year ?? undefined,
		trackNumber: t.track_number ?? undefined,
		discNumber: t.disc_number ?? undefined,
		dateAdded: t.date_added ?? undefined,
		format: t.format || undefined,
		sourceSampleRate: t.sample_rate || undefined,
		sourceBitDepth: t.bit_depth || undefined,
		sourceBitrate: t.bit_rate || undefined,
		favorite: t.favorite
	};
}

export type SearchBucket = 'albums' | 'artists' | 'tracks';
export type SearchScope = 'top' | SearchBucket | 'genres' | 'playlists';
const bucketSize = 24;

export async function search(
	session: Session,
	term: string,
	scope: 'top' | SearchBucket = 'top',
	offset = 0,
	signal?: AbortSignal
) {
	let result: Pick<Schema['SearchResponse'], 'albums' | 'artists' | 'tracks'>;
	let partial: boolean;
	let next: number | null = null;
	if (scope === 'top') {
		const response = await getJson<Schema['SearchResponse']>(
			session,
			path(
				'/api/v3/search',
				{},
				{
					q: term,
					buckets: 'albums,artists,tracks',
					limit_albums: 40,
					limit_artists: 24,
					limit_tracks: 24
				}
			),
			signal
		);
		result = response;
		partial = [response.album_status, response.artist_status, response.track_status].some(
			(s) => s !== 'ok'
		);
	} else {
		const page = await getJson<Schema['SearchBucketResponse']>(
			session,
			path('/api/v3/search/{bucket}', { bucket: scope }, { q: term, limit: bucketSize, offset }),
			signal
		);
		result = { albums: [], artists: [], tracks: [], [scope]: page.results };
		partial = page.status !== 'ok';
		next = page.results.length >= bucketSize ? offset + bucketSize : null;
	}
	const albums = result.albums
		.filter((a) => a.id || a.musicbrainz_id)
		.map((a): Album => ({
			title: a.title,
			artist: a.artist ?? '',
			year: a.year,
			localId: a.id,
			group: a.musicbrainz_id,
			art: cover(a.musicbrainz_id, a.id, a.art_missing),
			requested: a.requested
		}));
	const tracks = result.tracks.flatMap((t) => {
		if (!t.track || !t.id) return [];
		const d = t.track;
		const art = cover(d.release_group_mbid, d.album_id, t.art_missing, d.cover_available === true);
		return [
			{
				...playerTrack(t.id, t.title, t.artist ?? '', d.album_title, art, d.duration_seconds),
				albumId: d.album_id || undefined
			}
		];
	});
	const artists = result.artists
		.filter((a) => a.musicbrainz_id || a.id)
		.map((a) => ({
			name: a.title,
			localId: a.id,
			mbid: a.musicbrainz_id,
			disambiguation: a.disambiguation,
			artMissing: a.art_missing
		}));
	const recordings = result.tracks.flatMap((t) =>
		!t.track && t.musicbrainz_id && t.remote_track
			? [
					{
						requested: t.requested,
						art: cover(t.remote_track.release_group_mbid, undefined, t.art_missing),
						song: {
							recording_mbid: t.musicbrainz_id,
							artist_name: t.artist ?? '',
							track_title: t.title,
							...t.remote_track
						} satisfies Schema['TrackIntake']
					}
				]
			: []
	);
	return {
		albums,
		tracks,
		artists,
		recordings,
		partial,
		previous: Math.max(0, offset - bucketSize),
		next
	};
}

/** The match endpoint takes a local copy ID or chooses DN's preferred copy of a group. */
async function localTracks(
	session: Session,
	album: Album,
	signal?: AbortSignal
): Promise<Schema['TrackView'][]> {
	if (album.release && !album.localId) {
		const status = await getJson<Schema['LibraryAlbumStatus']>(
			session,
			path('/api/v3/library/albums/{id}/status', { id: album.release }),
			signal
		);
		// Several copies can hold this exact edition. Queue the one DN selects.
		return status.tracks.filter((track) => track.album_id === status.album_id);
	}
	const id = album.localId || album.group;
	if (!id) return [];
	const tracks: Schema['TrackView'][] = [];
	try {
		let total: number;
		do {
			const url = path(
				'/api/v3/library/albums/match/{mbid}',
				{ mbid: id },
				{ limit: 200, offset: tracks.length }
			);
			const page = await getJson<Schema['TrackPage']>(session, url, signal);
			tracks.push(...page.items);
			total = page.total;
			if (!page.items.length) break;
		} while (tracks.length < total);
		if (album.localId && tracks.length === total)
			void rememberAlbumCounts(session, [{ id: album.localId, track_count: total }]);
	} catch (e) {
		if (e instanceof DnError && e.status === 404 && !tracks.length) return [];
		throw e;
	}
	return tracks;
}

export async function albumTracks(session: Session, album: Album, signal?: AbortSignal) {
	const tracks = await localTracks(session, album, signal);
	return tracks
		.sort((a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number)
		.map((t) => localSong(t, album.artist));
}

export function editions(session: Session, albumId: string, signal?: AbortSignal) {
	return getJson<Schema['AlbumEditionsResponse']>(
		session,
		path('/api/v3/albums/{album_id}/editions', { album_id: albumId }),
		signal
	);
}

export function editionTracks(session: Session, albumId: string, release: string) {
	return getJson<Schema['AlbumTracksInfo']>(
		session,
		path('/api/v3/albums/{album_id}/editions/{release_mbid}/tracks', {
			album_id: albumId,
			release_mbid: release
		})
	);
}

export function editionLabel(e: Edition) {
	return (
		[
			e.disambiguation || e.title,
			e.date,
			e.country,
			e.media_formats?.join(' / '),
			e.label,
			e.catalog_number || e.barcode,
			e.track_count ? e.track_count + ' tracks' : ''
		]
			.filter(Boolean)
			.join(' · ') || e.release_mbid
	);
}

export async function requestAlbum(session: Session, album: Album, release: string | null) {
	if (!album.group) throw new Error('This album has no MusicBrainz release group.');
	const body: Schema['AlbumIntake'] = {
		musicbrainz_id: album.group,
		release_mbid: release,
		album: album.title,
		artist: album.artist,
		year: album.year
	};
	const answer = await postJson<Schema['IntakeResponse']>(
		session,
		path('/api/v3/requests/albums'),
		body
	);
	if (!answer.success)
		throw new Error(answer.message || 'DroppedNeedle could not accept the request.');
	return answer;
}

export function activeRequests(session: Session) {
	return getJson<Schema['ActiveRequestsResponse']>(session, path('/api/v3/requests/active'));
}

export function requestHistory(session: Session, page: number, status?: string, sort?: string) {
	return getJson<Schema['HistoryResponse']>(
		session,
		path('/api/v3/requests/history', {}, { page, page_size: 30, status, sort })
	);
}

export function requestedAlbum(r: RequestItem): Album | null {
	const group = r.request_kind === 'album' ? r.musicbrainz_id : r.track_release_group_mbid;
	return group
		? {
				title: r.album_title,
				artist: r.artist_name,
				group,
				year: r.year,
				release: r.release_mbid,
				imported: r.status === 'imported',
				art: cover(group),
				requested: !['failed', 'rejected', 'cancelled', 'incomplete', 'imported'].includes(r.status)
			}
		: null;
}

export function statusLabel(r: RequestItem) {
	const status = r.waiting_reason || r.task_state || r.status;
	return status.replaceAll('_', ' ').replace(/^./, (s) => s.toUpperCase());
}

export function errorMessage(e: unknown) {
	return e instanceof Error ? e.message : 'Could not reach DroppedNeedle.';
}
