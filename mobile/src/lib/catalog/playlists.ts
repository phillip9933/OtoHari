import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import type { PlayerTrack } from '../player';
import { validLocalFileId } from '../offline/tracks';
import { DnError, getJson, mutateJson, postJson, type Session } from '../connection';
import { cover, path, playerTrack, replayGainTags } from './catalog';
import {
	forgetPlaylist,
	rememberPlaylistList,
	rememberPlaylistTracks,
	rememberPinnedPlaylists
} from './playlistOffline';

type Schema = components['schemas'];
export type Playlist = Schema['PlaylistSummary'];

export async function playlists(session: Session, signal?: AbortSignal) {
	const list = await getJson<Schema['PlaylistListResponse']>(
		session,
		path('/api/v3/playlists'),
		signal
	);
	const visible = list.playlists.filter((p): p is Playlist => !p.is_redacted && 'name' in p);
	rememberPlaylistList(session, visible, playlistArtwork);
	return visible;
}

// Playlist imports may include an external artwork URL. Keep media on this DN server.
function localCover(raw?: string | null) {
	const album = raw?.match(/^\/api\/v3\/library\/albums\/([\w-]+)\/artwork(?:\?|$)/);
	if (album) return cover(null, album[1]);
	const group = raw?.match(/^\/api\/v3\/covers\/release-group\/([\w-]+)(?:\?|$)/);
	return group ? cover(group[1]) : undefined;
}

export function playlistArtwork(p: Playlist): string[] {
	if (p.custom_cover_url)
		return [
			path('/api/v3/playlists/{playlist_id}/cover', { playlist_id: p.id }, { v: p.updated_at })
		];
	return [
		...new Set((p.cover_urls ?? []).map((url) => localCover(url)).filter((s): s is string => !!s))
	].slice(0, 4);
}
export function playlistCover(p: Playlist) {
	return playlistArtwork(p)[0];
}

function tagNumber(n?: number | null) {
	return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

const incomplete = () =>
	Error('DN did not return the complete playlist. Existing automatic downloads were kept.');
function checkMembership(detail: Schema['PlaylistDetail'], id: string) {
	if (
		detail?.id !== id ||
		detail.is_redacted !== false ||
		typeof detail.is_owner !== 'boolean' ||
		typeof detail.name !== 'string' ||
		!Array.isArray(detail.tracks) ||
		detail.track_count !== detail.tracks.length
	)
		throw incomplete();
	const entries = new Set<string>();
	for (const row of detail.tracks) {
		if (
			!row ||
			typeof row.id !== 'string' ||
			!row.id ||
			entries.has(row.id) ||
			typeof row.source_type !== 'string' ||
			typeof row.track_name !== 'string' ||
			typeof row.artist_name !== 'string' ||
			typeof row.album_name !== 'string' ||
			(row.available_sources != null &&
				(!Array.isArray(row.available_sources) ||
					!row.available_sources.every((s) => typeof s === 'string')))
		)
			throw incomplete();
		entries.add(row.id);
	}
}

function localPlaylistFile(entry: Schema['PlaylistDetail']['tracks'][number]) {
	return entry.source_type === 'local'
		? entry.library_file_id || entry.track_source_id
		: entry.available_sources?.includes('local')
			? entry.library_file_id
			: null;
}
export async function observePlaylistMembership(session: Session, id: string) {
	const detail = await getJson<Schema['PlaylistDetail']>(
		session,
		path('/api/v3/playlists/{playlist_id}', { playlist_id: id })
	);
	checkMembership(detail, id);
	rememberPinnedPlaylists(session, [
		{ id, name: detail.name, ids: detail.tracks.map(localPlaylistFile).filter(validLocalFileId) }
	]);
}
export async function readPlaylist(
	session: Session,
	playlist: Pick<Playlist, 'id'>,
	signal?: AbortSignal,
	requireComplete = false
) {
	const params = { playlist_id: playlist.id };
	const url = path('/api/v3/playlists/{playlist_id}', params);
	let detail = await getJson<Schema['PlaylistDetail']>(session, url, signal);
	if (requireComplete) checkMembership(detail, playlist.id);
	const unresolved = detail.tracks.filter(
		(t) => !t.source_type && !t.library_file_id && t.album_id
	);
	let resolutionFailed = false;
	if (detail.is_owner && unresolved.length) {
		try {
			// DN links imported entries after the album arrives. The detail carries the new file IDs.
			const { sources } = await postJson<Schema['ResolveSourcesResponse']>(
				session,
				path('/api/v3/playlists/{playlist_id}/resolve-sources', params)
			);
			signal?.throwIfAborted();
			if (
				requireComplete &&
				detail.tracks.some(
					(t) =>
						!Array.isArray(sources?.[t.id]) || !sources[t.id].every((s) => typeof s === 'string')
				)
			)
				throw incomplete();
			const linked = unresolved.filter((t) => sources[t.id]?.includes('local'));
			if (linked.length) {
				detail = await getJson<Schema['PlaylistDetail']>(session, url, signal);
				if (requireComplete) {
					checkMembership(detail, playlist.id);
					const confirmed = new Set(
						detail.tracks
							.filter((t) => t.library_file_id || (t.source_type === 'local' && t.track_source_id))
							.map((t) => t.id)
					);
					if (linked.some((t) => !confirmed.has(t.id))) throw incomplete();
				}
			}
		} catch (cause) {
			signal?.throwIfAborted();
			if (cause instanceof DnError && [401, 403, 404].includes(cause.status)) throw cause;
			if (requireComplete) throw incomplete();
			resolutionFailed = true;
		}
	}
	let keepExisting = false;
	const tracks: PlayerTrack[] = [];
	const rows = detail.tracks.map((entry) => {
		const file = localPlaylistFile(entry);
		if (requireComplete) {
			if (file != null && !validLocalFileId(file)) throw incomplete();
			if (!file) {
				const claimsLocal =
					entry.source_type === 'local' || entry.available_sources?.includes('local');
				if (detail.is_owner && claimsLocal) throw incomplete();
				if (!detail.is_owner && (claimsLocal || !entry.source_type)) keepExisting = true;
			}
		}
		const index = file ? tracks.length : null;
		if (file)
			tracks.push({
				...playerTrack(
					file,
					entry.track_name,
					entry.artist_name,
					entry.album_name,
					localCover(entry.cover_url),
					entry.duration
				),
				recordingMbid: entry.recording_mbid || undefined,
				...replayGainTags(entry),
				albumId: validLocalFileId(entry.album_id) ? entry.album_id : undefined,
				artistId: validLocalFileId(entry.artist_id) ? entry.artist_id : undefined,
				format: typeof entry.format === 'string' ? entry.format.trim() || undefined : undefined,
				discNumber: tagNumber(entry.disc_number),
				trackNumber: tagNumber(entry.track_number)
			});
		return { entry, index };
	});
	signal?.throwIfAborted();
	if (!resolutionFailed && !(requireComplete && keepExisting))
		rememberPlaylistTracks(session, detail, tracks, playlistArtwork(detail));
	return { playlist: detail as Playlist, rows, tracks, resolutionFailed, keepExisting };
}

export function createPlaylist(session: Session, name: string) {
	return postJson<Schema['PlaylistDetail']>(session, path('/api/v3/playlists'), {
		name
	} satisfies Schema['CreatePlaylistBody']);
}

export function renamePlaylist(session: Session, id: string, name: string) {
	return mutateJson<Schema['PlaylistDetail']>(
		session,
		path('/api/v3/playlists/{playlist_id}', { playlist_id: id }),
		'PUT',
		{ name } satisfies Schema['UpdatePlaylistBody']
	);
}

export function addLocalTracks(session: Session, id: string, tracks: PlayerTrack[]) {
	return postJson<Schema['AddTracksResponse']>(
		session,
		path('/api/v3/playlists/{playlist_id}/tracks', { playlist_id: id }),
		{
			tracks: tracks.map((track) => ({
				track_name: track.title.trim() || 'Untitled track',
				artist_name: track.artist.trim() || 'Unknown artist',
				album_name: track.album.trim() || 'Unknown album',
				source_type: 'local',
				track_source_id: track.id,
				available_sources: ['local'],
				duration: track.duration,
				cover_url: localCover(track.artworkUrl)
			}))
		} satisfies Schema['AddTracksBody']
	);
}

export function movePlaylistEntry(session: Session, id: string, entry: string, position: number) {
	return mutateJson<Schema['ReorderResponse']>(
		session,
		path('/api/v3/playlists/{playlist_id}/tracks/reorder', { playlist_id: id }),
		'PATCH',
		{ track_id: entry, new_position: position } satisfies Schema['ReorderBody']
	);
}

export function removePlaylistEntry(session: Session, id: string, entry: string) {
	return mutateJson<Schema['StatusResponse']>(
		session,
		path('/api/v3/playlists/{playlist_id}/tracks/{track_id}', { playlist_id: id, track_id: entry }),
		'DELETE'
	);
}

export async function deletePlaylist(session: Session, id: string) {
	const result = await mutateJson<Schema['StatusResponse']>(
		session,
		path('/api/v3/playlists/{playlist_id}', { playlist_id: id }),
		'DELETE'
	);
	forgetPlaylist(session, id);
	return result;
}

export function playlistVisibility(session: Session, id: string, isPublic: boolean) {
	return mutateJson<Playlist>(
		session,
		path('/api/v3/playlists/{playlist_id}/visibility', { playlist_id: id }),
		'PATCH',
		{ is_public: isPublic } satisfies Schema['VisibilityBody']
	);
}

export type Member = Schema['PlaylistMember'];

export function playlistMembers(session: Session, id: string) {
	return getJson<Schema['MembersResponse']>(
		session,
		path('/api/v3/playlists/{playlist_id}/members', { playlist_id: id })
	);
}

export async function playlistPeople(session: Session, id: string) {
	const [members, directory, me] = await Promise.all([
		playlistMembers(session, id),
		getJson<Schema['UserDirectoryResponse']>(session, path('/api/v3/users/directory')),
		getJson<{ id: string }>(session, path('/api/v3/me'))
	]);
	return { members: members.members, users: directory.users.filter((user) => user.id !== me.id) };
}

export function sharePlaylist(session: Session, id: string, members: Member[]) {
	return mutateJson<Schema['MembersResponse']>(
		session,
		path('/api/v3/playlists/{playlist_id}/members', { playlist_id: id }),
		'PUT',
		{
			user_ids: members.map((member) => member.user_id),
			editor_ids: members.filter((member) => member.can_edit).map((member) => member.user_id)
		} satisfies Schema['MembersBody']
	);
}
