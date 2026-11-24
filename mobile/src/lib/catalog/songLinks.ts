import { tr } from '../i18n';

export type LinkStatus = 'read' | 'no_match' | 'unreadable' | 'needs_spotify';
export type ProviderStatus = 'ok' | 'partial' | 'timeout' | 'error' | 'stale';
const hosts = new Set([
	'open.spotify.com',
	'deezer.com',
	'www.deezer.com',
	'link.deezer.com',
	'music.apple.com',
	'geo.music.apple.com',
	'www.youtube.com',
	'youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'youtu.be',
	'song.link'
]);

// Share sheets can include a caption and tracking parameters. Only the music
// address goes to the listener's DN server. Resolution belongs to DN.
export function songLink(text: string): string | undefined {
	for (const word of text.slice(0, 8192).split(/\s+/)) {
		if (/^spotify:track:[A-Za-z0-9]{22}$/.test(word)) return word;
		if (!word.startsWith('https://')) continue;
		try {
			const url = new URL(word);
			if (!hosts.has(url.hostname) || url.username || url.password || url.port) continue;
			const clean = new URL(url.origin + url.pathname);
			const keep = url.hostname.endsWith('music.apple.com')
				? 'i'
				: url.pathname === '/watch'
					? 'v'
					: '';
			const id = keep && url.searchParams.get(keep);
			if (id) clean.searchParams.set(keep, id);
			return clean.href;
		} catch {
			/* Try the next word. */
		}
	}
}
export const hasLink = (text: string) => /(?:^|\s)(?:https?:\/\/|spotify:track:)/i.test(text);
export function linkNotice(status?: LinkStatus | null) {
	switch (status) {
		case 'read':
			return '';
		case 'no_match':
			return tr(
				'No MusicBrainz recording matches this link. Try the song title and artist.',
				'このリンクに一致する録音が見つかりません。曲名とアーティスト名で検索してください。'
			);
		case 'unreadable':
			return tr(
				'DroppedNeedle could not read this song link.',
				'DroppedNeedleでこの曲のリンクを読み取れませんでした。'
			);
		case 'needs_spotify':
			return tr(
				'Your DroppedNeedle admin needs to enable Spotify to read this link.',
				'このリンクを読むにはDroppedNeedleの管理者がSpotifyを有効にする必要があります。'
			);
		default:
			return tr(
				'This server did not resolve the link. Try searching by song title and artist.',
				'サーバーでリンクを解決できませんでした。曲名とアーティスト名で検索してください。'
			);
	}
}
export function providerNotice(status?: ProviderStatus) {
	switch (status) {
		case 'stale':
			return tr(
				'MusicBrainz is unavailable. Showing cached matches.',
				'MusicBrainzに接続できません。保存済みの結果を表示しています。'
			);
		case 'partial':
			return tr(
				'Some MusicBrainz results are unavailable.',
				'一部のMusicBrainz検索結果を取得できませんでした。'
			);
		case 'timeout':
			return tr(
				'MusicBrainz timed out. Available matches are shown.',
				'MusicBrainzの応答がタイムアウトしました。取得できた結果を表示します。'
			);
		case 'error':
			return tr(
				'MusicBrainz is unavailable. Library matches are still shown.',
				'MusicBrainzに接続できません。ライブラリの一致を表示します。'
			);
		default:
			return '';
	}
}
