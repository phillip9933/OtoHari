import type { Session } from '../connection';
import type { PlayerTrack } from '../player';
import type { Quality } from '../player/streaming';

export type OfflineAccount = Pick<Session, 'serverUrl' | 'userId'>;
export type OfflineOrigin = 'cached' | 'automatic' | 'downloaded';
export type PlaylistSource = `playlist:${string}`;
export type DownloadSource = 'off' | 'recent' | 'favorites' | PlaylistSource;

function hasControl(value: string) {
	for (const ch of value) {
		const n = ch.charCodeAt(0);
		if (n < 32 || (n >= 127 && n <= 159)) return true;
	}
	return false;
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function playlistSource(id: string): PlaylistSource | null {
	if (typeof id !== 'string' || !id.length || id.length > 256 || id === '.' || id === '..')
		return null;
	if (hasControl(id)) return null;
	const bytes = new TextEncoder().encode(id);
	if (bytes.length > 256 || utf8.decode(bytes) !== id) return null;
	return `playlist:${btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')}`;
}
export function playlistId(source: unknown): string | null {
	if (typeof source !== 'string' || !/^playlist:[A-Za-z0-9_-]{1,342}$/.test(source)) return null;
	try {
		const bytes = atob(source.slice(9).replaceAll('-', '+').replaceAll('_', '/'));
		const id = utf8.decode(Uint8Array.from(bytes, (ch) => ch.charCodeAt(0)));
		return playlistSource(id) === source ? id : null;
	} catch {
		return null;
	}
}
export function validDownloadSource(value: unknown): value is DownloadSource {
	return (
		value === 'off' || value === 'recent' || value === 'favorites' || playlistId(value) !== null
	);
}
export function validLocalFileId(id: unknown): id is string {
	return (
		typeof id === 'string' &&
		!!id &&
		id !== '.' &&
		id !== '..' &&
		!id.includes('/') &&
		!id.includes('\\') &&
		!hasControl(id)
	);
}
export type OfflinePin = {
	kind: 'playlist' | 'artist' | 'recent' | 'favorites' | 'filter';
	id: string;
	name: string;
	group?: 'songs' | 'albums' | 'artists';
	filters?: Record<string, string>;
};
export type OfflineOptions = {
	readAheadWifi?: number;
	readAheadCellular?: number;
	readAheadWifiKiBps?: number;
	readAheadCellularKiBps?: number;
	completeDownloads?: boolean;
	notifyDownloads?: boolean;
	downloadWaveforms?: boolean;
	downloadQuality?: Quality;
	offlinePins?: OfflinePin[];
	autoDownload: DownloadSource;
	downloadMiB: number;
	autoCache: boolean;
	unmeteredOnly: boolean;
	cacheMiB: number;
	offlineOnly: boolean;
};
export type OfflineItem = {
	mime?: string;
	track: PlayerTrack;
	origin: OfflineOrigin;
	pinned: boolean;
	bytes: number;
	used: number;
};
export type OfflineSnapshot = {
	items: OfflineItem[];
	options: OfflineOptions;
	pinnedPlaylists?: { id: string; name: string; ids: string[] }[];
};
export const offlineDefaults: OfflineOptions = {
	autoDownload: 'off',
	downloadMiB: 512,
	autoCache: false,
	unmeteredOnly: true,
	cacheMiB: 512,
	offlineOnly: false
};
export const cacheSizes = [128, 256, 512, 1024, 2048, 4096];

export function retainedTrack(track: PlayerTrack, serverUrl: string): PlayerTrack {
	const base = new URL(serverUrl);
	base.pathname = base.pathname.replace(/\/?$/, '/');
	const stream = new URL(track.streamUrl.replace(/^\/(?!\/)/, ''), base);
	const path = 'api/v3/stream/local/' + encodeURIComponent(track.id);
	if (
		!track.id ||
		base.protocol !== 'https:' ||
		stream.origin !== base.origin ||
		stream.username ||
		stream.password ||
		stream.pathname !== base.pathname + path
	)
		throw Error('Choose a song in this DroppedNeedle library.');
	let artworkUrl: string | undefined;
	if (track.artworkUrl) {
		const art = new URL(track.artworkUrl.replace(/^\/(?!\/)/, ''), base);
		if (
			art.origin === base.origin &&
			!art.username &&
			!art.password &&
			art.pathname.startsWith(base.pathname + 'api/v3/')
		) {
			artworkUrl = '/' + art.pathname.slice(base.pathname.length);
			const size = art.searchParams.get('size');
			if (size && /^[0-9]{1,4}$/.test(size)) artworkUrl += '?size=' + size;
		}
	}
	const details: Partial<PlayerTrack> = {};
	for (const key of [
		'albumId',
		'artistId',
		'albumArtist',
		'albumArtistId',
		'genre',
		'format',
		'artistMbid',
		'releaseGroupMbid',
		'recordingMbid'
	] as const)
		if (typeof track[key] === 'string' && track[key]) details[key] = track[key];
	for (const key of [
		'year',
		'trackNumber',
		'discNumber',
		'dateAdded',
		'rating',
		'sourceSampleRate',
		'sourceBitDepth',
		'sourceBitrate',
		'replayGainTrackDb',
		'replayGainAlbumDb',
		'replayGainTrackPeak',
		'replayGainAlbumPeak'
	] as const)
		if (typeof track[key] === 'number' && Number.isFinite(track[key])) details[key] = track[key];
	if (typeof track.favorite === 'boolean') details.favorite = track.favorite;
	return {
		...details,
		id: track.id,
		title: track.title,
		album: track.album,
		artist: track.artist,
		duration: track.duration,
		streamUrl: '/' + path,
		artworkUrl
	};
}
