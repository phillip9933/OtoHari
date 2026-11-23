import { forgetPlaylistCover } from './playlistCoverOverrides';
import { accountId } from '../boards/layout';
import { libraryFilter, type LibraryFilter } from '../boards/filteredSections';
import type { Session } from '../connection';
import type { PlayerTrack } from '../player';
import { maxQueueTracks, prepareLibraryQueue, type TrackPage } from './libraryQueue';
import {
	deviceTrackOrder,
	foldSearchText,
	matchesDeviceTrack,
	requestFilters
} from './trackFilters';
import { offlineInventory } from '../offline/media';

export type SmartPlaylist = LibraryFilter & {
	id: string;
	name: string;
	limit: number;
	order: 'asc' | 'desc';
	genre?: string;
	yearFrom?: number;
	yearTo?: number;
	minPlays?: number;
	maxPlays?: number;
	notPlayedDays?: number;
};
type PlayStat = NonNullable<TrackPage['play_stats']>[string];
function optionalInteger(value: unknown, min: number, max: number, name: string) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
		throw Error(name + ' must be a whole number between ' + min + ' and ' + max + '.');
	return value;
}

async function prefix(session: Session) {
	return (
		'dn.mobile.smart-playlists.v1.' +
		JSON.stringify([session.serverUrl, await accountId(session)]) +
		'.'
	);
}
function rule(value: Partial<SmartPlaylist>): SmartPlaylist {
	if (!value || typeof value.id !== 'string' || !/^smart-[a-z0-9-]{1,64}$/i.test(value.id))
		throw new Error('This smart playlist has an invalid ID.');
	const name = typeof value.name === 'string' ? value.name.trim() : '';
	if (!name || name.length > 64)
		throw new Error('Give the playlist a name of up to 64 characters.');
	const limit = value.limit;
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maxQueueTracks)
		throw new Error('Choose a playlist limit between 1 and 2,000 tracks.');
	const genre = value.genre?.trim();
	if (genre && genre.length > 160) throw Error('Choose a genre up to 160 characters.');
	const yearFrom = optionalInteger(value.yearFrom, 1, 9999, 'Earliest year');
	const yearTo = optionalInteger(value.yearTo, 1, 9999, 'Latest year');
	const minPlays = optionalInteger(value.minPlays, 0, 1_000_000, 'Minimum plays');
	const maxPlays = optionalInteger(value.maxPlays, 0, 1_000_000, 'Maximum plays');
	const notPlayedDays = optionalInteger(value.notPlayedDays, 1, 36_500, 'Days since last play');
	if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo)
		throw Error('Earliest year must come before or match latest year.');
	if (minPlays !== undefined && maxPlays !== undefined && minPlays > maxPlays)
		throw Error('Minimum plays cannot exceed maximum plays.');
	return {
		...libraryFilter({ ...value, kind: 'songs' }),
		id: value.id,
		name,
		limit,
		order: value.order === 'desc' ? 'desc' : 'asc',
		genre: genre || undefined,
		yearFrom,
		yearTo,
		minPlays,
		maxPlays,
		notPlayedDays
	};
}
export async function readSmartPlaylists(session: Session): Promise<SmartPlaylist[]> {
	const namespace = await prefix(session);
	const lists: SmartPlaylist[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (!key?.startsWith(namespace) || key.endsWith('.matches')) continue;
		try {
			const item = rule(JSON.parse(localStorage.getItem(key) ?? 'null'));
			if (key === namespace + item.id) lists.push(item);
		} catch {
			// A damaged rule should not hide other playlists on the device.
		}
	}
	return lists.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function writeSmartPlaylist(
	session: Session,
	next: SmartPlaylist | null,
	previous?: SmartPlaylist
) {
	const stored = next && rule(next);
	const id = previous?.id ?? stored?.id;
	if (!id || (stored && stored.id !== id)) throw new Error('Choose a smart playlist to edit.');
	const key = (await prefix(session)) + id;
	const current = localStorage.getItem(key);
	if (
		previous
			? !current || JSON.stringify(rule(JSON.parse(current))) !== JSON.stringify(rule(previous))
			: !!current
	)
		throw new Error('This playlist changed. Reopen it before saving your edits.');
	if (stored) localStorage.setItem(key, JSON.stringify(stored));
	else {
		localStorage.removeItem(key);
		await forgetPlaylistCover(session, 'smart:' + id);
	}
	localStorage.removeItem(key + '.matches');
}

export async function smartPlaylistTracks(
	session: Session,
	playlist: SmartPlaylist,
	signal = new AbortController().signal,
	availableTracks?: PlayerTrack[]
) {
	const item = rule(playlist);
	const filters = { ...item, q: item.query };
	const key = (await prefix(session)) + item.id;
	const definition = JSON.stringify(item);
	const needsStats =
		item.minPlays !== undefined || item.maxPlays !== undefined || item.notPlayedDays !== undefined;
	const cutoff =
		item.notPlayedDays === undefined ? undefined : Date.now() / 1000 - item.notPlayedDays * 86400;
	const yearMatches = (year?: number | null) =>
		(item.yearFrom === undefined || (year != null && year >= item.yearFrom)) &&
		(item.yearTo === undefined || (year != null && year <= item.yearTo));
	const historyMatches = (stats?: PlayStat) =>
		!needsStats ||
		(!!stats &&
			(item.minPlays === undefined || stats.play_count >= item.minPlays) &&
			(item.maxPlays === undefined || stats.play_count <= item.maxPlays) &&
			(cutoff === undefined ||
				stats.play_count === 0 ||
				(stats.last_played != null && stats.last_played <= cutoff)));
	signal.throwIfAborted();
	if (availableTracks) {
		let ids: string[] = [];
		let stats: Record<string, PlayStat> = {};
		try {
			const known = JSON.parse(localStorage.getItem(key + '.matches') ?? 'null');
			if (known?.definition === definition && Array.isArray(known.ids)) {
				ids = known.ids;
				stats = known.stats ?? {};
			}
		} catch {
			/* Device metadata can still be filtered without a saved match list. */
		}
		const confirmed = new Set(ids);
		return availableTracks
			.filter((t) => {
				const verified = confirmed.has(t.id);
				const genreMatches =
					!item.genre ||
					(t.genre
						? [t.genre, ...t.genre.split(/[;|]/)].some(
								(g) => foldSearchText(g.trim()) === foldSearchText(item.genre!)
							)
						: verified);
				return (
					matchesDeviceTrack(t, filters, verified) &&
					genreMatches &&
					(yearMatches(t.year) || (!t.year && verified)) &&
					historyMatches(stats[t.id])
				);
			})
			.sort(deviceTrackOrder(filters))
			.slice(0, item.limit);
	}
	// Retain verified history for playable downloads even when a time rule excludes them today.
	const localIds =
		needsStats && session.userId
			? (await offlineInventory(session).catch(() => undefined))?.byId
			: undefined;
	const stats: Record<string, PlayStat> = Object.create(null);
	const advanced = needsStats || item.yearFrom !== undefined || item.yearTo !== undefined;
	function matches(row: TrackPage['items'][number], page: TrackPage) {
		let played: PlayStat | undefined;
		if (needsStats) {
			if (!page.play_stats)
				throw Error('Update your DN server to use play count and last-played rules.');
			played = Object.hasOwn(page.play_stats, row.id) ? page.play_stats[row.id] : { play_count: 0 };
		}
		const matched = yearMatches(row.year) && historyMatches(played);
		if (played && (matched || localIds?.has(row.id))) stats[row.id] = played;
		return matched;
	}
	const tracks = await prepareLibraryQueue(
		session,
		{
			...requestFilters(filters),
			genre: item.genre,
			include_play_stats: needsStats ? 'true' : undefined
		},
		signal,
		undefined,
		true,
		{ limit: item.limit, matches: advanced ? matches : undefined }
	);
	signal.throwIfAborted();
	try {
		// An offline copy can predate rating and format metadata. Remember only verified matches.
		if (localStorage.getItem(key) === definition)
			localStorage.setItem(
				key + '.matches',
				JSON.stringify({
					definition,
					ids: tracks.map((t) => t.id),
					stats: needsStats ? stats : undefined
				})
			);
	} catch {
		/* A full device can still play the online result. */
	}
	return tracks;
}
