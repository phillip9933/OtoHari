import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { getJson, type Session } from '../connection';
import { localSong, path, type Album } from './catalog';

type Schema = components['schemas'];
export type Listen = Schema['TrackRef'];

// Seed a newly opened section with the preview this sign-in has already loaded.
export const recentAlbumPreviews = new WeakMap<Session, Album[]>();
export const recentPlayPreviews = new WeakMap<Session, Awaited<ReturnType<typeof recentListens>>>();

export const libraryWidgets = [
	{ id: 'library-albums', label: 'Albums' },
	{ id: 'library-artists', label: 'Artists' },
	{ id: 'library-tracks', label: 'Tracks' },
	{ id: 'library-playlists', label: 'Playlists' },
	{ id: 'library-genres', label: 'Library genres' },
	{ id: 'library-recently-added', label: 'Recently added' },
	{ id: 'library-recently-played', label: 'Recently played' }
] as const;

export async function recentListens(session: Session) {
	const home = await getJson<Schema['HomeResponse']>(session, path('/api/v3/home'));
	const section = home.sections.find((s) => s.key === 'recently_played')?.content;
	const shelf = section?.shape === 'shelf' ? section.shelf : undefined;
	const listens =
		shelf?.source === 'local' && shelf.type === 'tracks'
			? shelf.items.filter((i) => i.kind === 'track')
			: [];
	if (section) return { listens, refreshing: home.refreshing, disabled: false };
	const prefs = await getJson<Schema['SectionPrefsResponse']>(
		session,
		path('/api/v3/me/section-prefs')
	).catch(() => null);
	const disabled =
		prefs?.pages?.home?.find((item) => item.key === 'recently_played')?.enabled === false;
	return { listens, refreshing: home.refreshing && !disabled, disabled };
}

export async function findListen(session: Session, listen: Listen, signal?: AbortSignal) {
	const id = listen.musicbrainz_id?.trim().toLowerCase(),
		title = listen.title.trim();
	if (!id || !title) return 'Local copy unknown';
	// The history shelf has no file IDs. Search streamable local files only.
	// If the result is too broad to check in full, leave the listen unresolved.
	let after: string | undefined, match: Schema['TrackView'] | undefined;
	for (let pages = 0; pages < 5; pages++) {
		const page = await getJson<Schema['TrackListPage']>(
			session,
			path('/api/v3/library/tracks', {}, { q: title, limit: 100, after }),
			signal
		);
		for (const track of page.items) {
			if (track.recording_mbid?.toLowerCase() !== id) continue;
			if (match && match.id !== track.id) return 'Multiple local copies';
			match = track;
		}
		if (!page.next) return match ? localSong(match) : 'Local copy unavailable';
		after = page.next;
	}
	return 'Local copy could not be verified';
}
