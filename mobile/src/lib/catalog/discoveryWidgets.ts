import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { getJson, postJson, type Session } from '../connection';
import { path, localSong, type Album } from './catalog';
import {
	discover,
	createShelf,
	addAlbum,
	addArtist,
	type Shelf,
	type ChartRange,
	type DiscoveryPage
} from './discovery';
import { playlists } from './playlists';

type S = components['schemas'];
// The DN Discover registry, including the two actions that have their own endpoints.
const sections = {
	discover_queue: 'Discover queue',
	top_picks: 'Top picks for you',
	listeners_like_you: 'Listening lounge',
	weekly_exploration: 'Weekly exploration',
	playlist_discovery: 'Discover for a playlist',
	daily_mixes: 'Daily mixes',
	radio_sections: 'Radio stations',
	because_you_listen_to: 'Because you listened',
	artists_you_might_like: 'Artists you might like',
	popular_in_your_genres: 'Popular in your genres',
	fresh_releases: 'Fresh releases',
	new_from_followed: 'New from artists you follow',
	missing_essentials: 'Missing essentials',
	rediscover: 'Rediscover',
	anniversaries: 'Milestone anniversaries',
	lastfm_recent_scrobbles: 'Recent scrobbles',
	unexplored_genres: 'Unexplored genres',
	genre_list: 'Genres',
	globally_trending: 'Globally trending',
	lastfm_weekly_artist_chart: 'Last.fm weekly artists',
	lastfm_weekly_album_chart: 'Last.fm weekly albums'
} satisfies Partial<Record<S['SectionKey'], string>>;
const individual = {
	popular_albums: 'Popular albums',
	trending_artists: 'Trending artists',
	your_top_albums: 'Your top albums',
	following: 'Followed artists',
	releases: 'New releases from followed artists',
	concerts: 'Upcoming concerts'
};
export const discoveryWidgets: readonly { id: string; label: string }[] = Object.entries({
	...sections,
	...individual
}).map(([key, label]) => ({ id: `discover-${key}`, label }));
export const defaultDiscoveryWidgets = [
	'discover-top_picks',
	'discover-because_you_listen_to',
	'discover-fresh_releases',
	'discover-genre_list'
] as const;
export type ShelfSong = {
	title: string;
	artist: string;
	album?: string | null;
	recording?: string | null;
	group?: string | null;
};
export type FeatureShelf = Shelf & {
	songs: ShelfSong[];
	genres: string[];
	note?: string | null;
	radio?: { kind: 'artist' | 'album' | 'genre'; id: string };
};
export type DeckCard = { album: Album; artistId?: string | null; reason: string };
export type WidgetResult = Omit<DiscoveryPage, 'shelves'> & {
	shelves: FeatureShelf[];
	playlists?: { id: string; name: string }[];
	cards?: DeckCard[];
};
function featureShelf(title: string): FeatureShelf {
	return { ...createShelf(title), songs: [], genres: [] };
}
function fromChart(chart: S['ChartSection']): FeatureShelf {
	const list = featureShelf(chart.title);
	list.note = chart.fallback_message;
	if (chart.radio_seed_id && chart.radio_seed_type && chart.radio_seed_type !== 'items')
		list.radio = { kind: chart.radio_seed_type, id: chart.radio_seed_id };
	for (const row of chart.items) {
		switch (row.kind) {
			case 'album':
				addAlbum(list, row);
				break;
			case 'artist':
				addArtist(list, row);
				break;
			case 'genre':
				list.genres.push(row.name);
				break;
			case 'track':
				list.songs.push({
					title: row.title,
					artist: row.artist_name ?? '',
					album: row.album_name,
					recording: row.musicbrainz_id
				});
				break;
		}
	}
	return list;
}
function unwrap(section: S['PageSection']): FeatureShelf[] {
	const data = section.content;
	switch (data.shape) {
		case 'shelf':
			return [fromChart(data.shelf)];
		case 'shelves':
			return data.shelves.map(fromChart);
		case 'because':
			return data.entries.map((entry) => {
				const list = fromChart(entry.section);
				list.title = entry.section.title || entry.seed_artist;
				return list;
			});
		case 'picks': {
			const list = featureShelf(data.picks.title);
			data.picks.items.forEach((pick) => addAlbum(list, pick.album));
			return [list];
		}
		case 'weekly': {
			const list = featureShelf(data.weekly.title);
			list.songs = data.weekly.tracks.map((track) => ({
				title: track.title,
				artist: track.artist_name,
				album: track.album_name,
				recording: track.recording_mbid,
				group: track.release_group_mbid
			}));
			return [list];
		}
	}
}
// A board can mount many shelves from the same snapshot. Cache successful requests per
// session and share pending promises even if fetching takes longer than the freshness window.
function sharedRead<T>(load: (session: Session) => Promise<T>) {
	const entries = new WeakMap<Session, { promise: Promise<T>; expires: number }>();
	const read = (session: Session) => {
		const old = entries.get(session);
		if (old && old.expires > Date.now()) return old.promise;
		const entry = { promise: load(session), expires: Infinity };
		entries.set(session, entry);
		entry.promise.then(
			() => {
				entry.expires = Date.now() + 9000;
			},
			() => {
				if (entries.get(session) === entry) entries.delete(session);
			}
		);
		return entry.promise;
	};
	return Object.assign(read, { clear: (session: Session) => entries.delete(session) });
}
const snapshot = sharedRead((session) =>
	getJson<S['DiscoverResponse']>(session, path('/api/v3/discover'))
);
const settings = sharedRead((session) =>
	getJson<S['SectionPrefsResponse']>(session, path('/api/v3/me/section-prefs'))
);
export async function searchGenres(session: Session, signal: AbortSignal) {
	signal.throwIfAborted();
	const page = await snapshot(session);
	signal.throwIfAborted();
	const section = page.sections.find((s) => s.key === 'genre_list');
	return section ? [...new Set(unwrap(section).flatMap((s) => s.genres))] : [];
}
export function forgetDiscoveryPage(session: Session) {
	snapshot.clear(session);
	settings.clear(session);
}
async function missingReason(session: Session, key: string) {
	const pref = (await settings(session)).pages.discover?.find((item) => item.key === key);
	if (!pref) return '';
	if (pref.turned_off)
		return 'This integration is disabled on the server. An administrator can enable it in DroppedNeedle settings.';
	if (!pref.enabled)
		return 'This section is disabled in DroppedNeedle. Enable it in Settings → Account-wide content visibility → Discover.';
	if (!pref.available) {
		if (pref.requires === 'lastfm' || pref.requires === 'listenbrainz')
			return `Connect ${pref.requires === 'lastfm' ? 'Last.fm' : 'ListenBrainz'} in your DroppedNeedle profile under Scrobbling to enable this section.`;
		return `Ask a DroppedNeedle administrator to configure ${pref.requires === 'library' ? 'the music library' : 'the required integration'} in server settings.`;
	}
	return '';
}
const otherViews = {
	popular_albums: 'popular',
	trending_artists: 'trending',
	your_top_albums: 'top',
	following: 'following',
	releases: 'releases',
	concerts: 'concerts'
} as const;
export const isChart = (id: string) =>
	['discover-popular_albums', 'discover-trending_artists', 'discover-your_top_albums'].includes(id);
export async function readWidget(
	session: Session,
	id: string,
	range: ChartRange,
	offset: number,
	playlistId: string,
	previewCapacity?: number
): Promise<WidgetResult> {
	const key = id.slice('discover-'.length);
	if (Object.hasOwn(otherViews, key)) {
		const result = await discover(
			session,
			otherViews[key as keyof typeof otherViews],
			range,
			offset,
			previewCapacity
		);
		return { ...result, shelves: result.shelves.map((s) => ({ ...s, genres: [], songs: [] })) };
	}
	if (!Object.hasOwn(sections, key)) throw new Error('Unknown Discover section.');
	if (key === 'discover_queue' || key === 'playlist_discovery') {
		const msg = await missingReason(session, key);
		if (msg) return { shelves: [], notice: msg };
		if (key === 'discover_queue') {
			const snap = await snapshot(session);
			if (!snap.discover_queue_enabled)
				return {
					shelves: [],
					notice: 'The discovery queue is disabled in DroppedNeedle. Check Settings → Discover.'
				};
			const deck = await getJson<S['DiscoverQueueResponse']>(
				session,
				path('/api/v3/discover/queue')
			);
			const list = featureShelf('');
			for (const a of deck.items ?? []) addAlbum(list, { ...a, requested: false });
			return {
				shelves: [list],
				cards: list.albums.map((album) => {
					const row = deck.items?.find((item) => item.musicbrainz_id === album.group);
					return { album, artistId: row?.artist_id, reason: row?.recommendation_reason || '' };
				})
			};
		}
		const options = (await playlists(session))
			.filter((p) => p.is_owner)
			.map((p) => ({ id: p.id, name: p.name }));
		if (!playlistId || !options.some((p) => p.id === playlistId))
			return { playlists: options, shelves: [] };
		const suggestions = await postJson<S['PlaylistSuggestionsResponse']>(
			session,
			path('/api/v3/discover/playlist-suggestions'),
			{
				playlist_id: playlistId,
				count: previewCapacity ?? 15
			} satisfies S['PlaylistSuggestionsRequest']
		);
		return { playlists: options, shelves: [fromChart(suggestions.suggestions)] };
	}
	const page = await snapshot(session),
		section = page.sections.find((s) => s.key === key);
	if (key === 'listeners_like_you') {
		const disabled = section ? '' : await missingReason(session, key);
		if (disabled) return { shelves: [], notice: disabled };
		const list = section ? unwrap(section)[0] : featureShelf('');
		const picks = page.sections.find((s) => s.key === 'top_picks')?.content;
		if (picks?.shape === 'picks')
			picks.picks.items.slice(3).forEach((p) => addAlbum(list, p.album));
		if (list.albums.length)
			return {
				shelves: [{ ...list, albums: list.albums.slice(0, 15) }],
				refreshing: page.refreshing
			};
	}
	if (section) {
		const shelves = unwrap(section);
		const content = section.content;
		if (content.shape === 'picks') {
			const cards = shelves[0].albums.map((album) => {
				const pick = content.picks.items.find((p) =>
					album.localId
						? p.album.local_id === album.localId
						: p.album.musicbrainz_id === album.group
				);
				return {
					album,
					artistId: pick?.album.artist_id,
					reason: pick ? [`${pick.match_pct}% match`, ...pick.reasons].join(' · ') : ''
				};
			});
			return { shelves, cards, refreshing: page.refreshing };
		}
		return { shelves, refreshing: page.refreshing };
	}
	const unavailable = await missingReason(session, key);
	return {
		shelves: [],
		notice:
			unavailable ||
			(page.refreshing
				? 'DroppedNeedle is updating this section.'
				: 'DroppedNeedle has no items for this section yet.'),
		refreshing: !unavailable && page.refreshing
	};
}
function comparable(value: string | null | undefined) {
	return value?.normalize('NFC').trim().toLowerCase() ?? '';
}
export async function playableSong(session: Session, song: ShelfSong) {
	let after: string | undefined;
	let fallback: S['TrackView'] | undefined;
	const seen = new Set<string>();
	do {
		const page: S['TrackListPage'] = await getJson(
			session,
			path('/api/v3/library/tracks', {}, { q: song.title, limit: 100, after })
		);
		const exact = page.items.find((t) => song.recording && t.recording_mbid === song.recording);
		if (exact) return localSong(exact);
		fallback ??= page.items.find(
			(t) =>
				!(song.recording && t.recording_mbid) &&
				comparable(t.title) === comparable(song.title) &&
				!!song.artist &&
				comparable(t.artist_name || t.album_artist_name) === comparable(song.artist) &&
				(!song.group || !t.release_group_mbid || t.release_group_mbid === song.group) &&
				(!song.album || comparable(t.album_title) === comparable(song.album))
		);
		if (fallback && !song.recording) break;
		after = page.next ?? undefined;
		if (!after || seen.has(after)) break;
		seen.add(after);
	} while (after);
	return fallback ? localSong(fallback) : null;
}
