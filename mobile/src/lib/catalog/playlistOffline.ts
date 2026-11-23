import type { Session } from '../connection';
import type { PlayerTrack } from '../player';
import type { Playlist } from './playlists';
import { tr } from '../i18n';
type RecordValue = { id: string; name: string; covers: string[]; ids?: string[] };
function key(session: Pick<Session, 'serverUrl' | 'userId'>) {
	return session.userId
		? 'dn.mobile.offline-playlists.v1.' + JSON.stringify([session.serverUrl, session.userId])
		: null;
}
function read(key: string): RecordValue[] {
	try {
		const value = JSON.parse(localStorage.getItem(key) ?? '[]');
		return Array.isArray(value)
			? value.filter(
					(p) => typeof p?.id === 'string' && typeof p.name === 'string' && Array.isArray(p.covers)
				)
			: [];
	} catch {
		return [];
	}
}
function write(k: string, value: RecordValue[]) {
	try {
		const encoded = JSON.stringify(value);
		if (localStorage.getItem(k) === encoded) return;
		localStorage.setItem(k, encoded);
		window.dispatchEvent(new CustomEvent('dn-playlist-membership', { detail: k }));
	} catch {
		/* An exhausted browser cache leaves playback available by track. */
	}
}
export function onPlaylistMembership(session: Session, changed: () => void) {
	const owner = key(session);
	const handle = (e: Event) => {
		if ((e as CustomEvent).detail === owner) changed();
	};
	window.addEventListener('dn-playlist-membership', handle);
	return () => window.removeEventListener('dn-playlist-membership', handle);
}
export function rememberedPlaylistCovers(session: Session) {
	const k = key(session);
	return new Map(k ? read(k).map(({ id, covers }) => [id, covers] as const) : []);
}
export function rememberedPlaylistNames(session: Session) {
	const k = key(session);
	return k ? read(k).map(({ id, name }) => ({ id, name })) : [];
}
export function rememberedPlaylistTrackIds(session: Session, id: string) {
	const k = key(session);
	return k ? read(k).find((p) => p.id === id)?.ids : undefined;
}
export function rememberPlaylistList(
	session: Session,
	list: Playlist[],
	art: (p: Playlist) => string[]
) {
	const k = key(session);
	if (!k) return;
	const old = new Map(read(k).map((p) => [p.id, p]));
	write(
		k,
		list.map((p) => ({ id: p.id, name: p.name, covers: art(p), ids: old.get(p.id)?.ids }))
	);
}
export function rememberPlaylistTracks(
	session: Session,
	p: Playlist,
	tracks: PlayerTrack[],
	covers: string[]
) {
	const k = key(session);
	if (!k) return;
	write(k, [
		...read(k).filter((x) => x.id !== p.id),
		{ id: p.id, name: p.name, covers, ids: tracks.map((t) => t.id) }
	]);
}
export function forgetPlaylist(session: Session, id: string) {
	const k = key(session);
	if (k)
		write(
			k,
			read(k).filter((p) => p.id !== id)
		);
}
export function rememberPinnedPlaylists(
	account: Pick<Session, 'serverUrl' | 'userId'>,
	memberships: { id: string; name: string; ids: string[] }[]
) {
	const k = key(account);
	if (!k || !memberships.length) return;
	const previous = read(k);
	const byId = new Map(previous.map((p) => [p.id, p]));
	let changed = false;
	for (const item of memberships) {
		const old = byId.get(item.id);
		if (
			old?.name === item.name &&
			old.ids?.length === item.ids.length &&
			old.ids.every((id, i) => id === item.ids[i])
		)
			continue;
		byId.set(item.id, { id: item.id, name: item.name, ids: item.ids, covers: old?.covers ?? [] });
		changed = true;
	}
	if (changed) write(k, [...byId.values()]);
}
export function offlinePlaylists(session: Session, tracks: PlayerTrack[], onlyId?: string) {
	const k = key(session);
	if (!k) return [];
	const byId = new Map(tracks.map((t) => [t.id, t]));
	return read(k).flatMap((p) => {
		if (onlyId && 'playlist:' + p.id !== onlyId) return [];
		const available = (p.ids ?? []).flatMap((id) => byId.get(id) ?? []);
		return available.length
			? [
					{
						id: 'playlist:' + p.id,
						title: p.name,
						count: available.length,
						knownPlayable: p.ids?.length,
						get subtitle() {
							return tr(
								available.length + ' available offline',
								'オフラインで再生可能：' + available.length.toLocaleString() + '曲'
							);
						},
						covers: p.covers,
						localTracks: available
					}
				]
			: [];
	});
}
