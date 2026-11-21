import { japaneseText } from '../i18n';
import type { LayoutTarget } from '../boards/layout';

export const pageTitles = {
	home: 'Edit Home layout',
	library: 'Edit Library layout',
	discover: 'Edit Discover layout',
	player: 'Edit Now Playing layout',
	themes: 'Themes',
	interface: 'Interface and navigation',
	language: 'App language',
	playback: 'Streaming and fades',
	queue: 'Queue and autoplay',
	offline: 'Offline and cache',
	outputs: 'Cast and audio output',
	equalizer: 'Equalizer',
	handoff: 'Player handoff',
	account: 'Account on DroppedNeedle',
	stats: 'Library statistics',
	content: 'Content preferences',
	tools: 'Web tools',
	diagnostics: 'Server diagnostics',
	scans: 'Library health and scans',
	releases: 'Release types',
	editions: 'Edition preferences',
	updates: 'App updates',
	about: 'About'
} as const;
export type SettingsPage = Exclude<keyof typeof pageTitles, 'outputs'> | 'menu' | LayoutTarget;
type Page = keyof typeof pageTitles;
type Access = {
	signedIn: boolean;
	account: boolean;
	admin: boolean;
	android: boolean;
	ios: boolean;
	offline: boolean;
};
type Entry = {
	page: Page;
	label: string;
	anchor?: string;
	terms?: string;
	account?: boolean;
	native?: boolean;
};
const groups: Partial<Record<Page, string>> = {
	language: 'English Japanese 日本語 英語 言語 system locale',
	player: 'player composer layout buttons artwork rows columns lyrics 歌詞 ボタン 配置',
	home: 'pins sections shelves ホーム ピン',
	library: 'filters sections shelves フィルター',
	discover: 'sections shelves 表示',
	queue:
		'play queue autoplay similar library music extend playback when the queue ends up next 再生キュー 自動再生 関連する曲 似ている曲 再生を延長',
	handoff: 'remote control devices transfer 引き継ぎ',
	themes: 'appearance colors palette dark light midnight custom CSS テーマ 配色',
	outputs: 'AirPlay Chromecast DLNA Sonos speaker audio output キャスト スピーカー',
	equalizer: 'headphones EQ presets frequency bands イコライザー ヘッドホン',
	account: 'profile username sign in sessions devices services email scrobble last.fm プロフィール',
	content: 'home discover sidebar sections サイドバー',
	tools: 'browser web administration ウェブ',
	stats: 'statistics totals library 統計',
	diagnostics: 'server workload jobs limits サーバー 診断',
	scans: 'health library scans refresh scans スキャン',
	releases: 'album EP singles アルバム シングル',
	editions: 'preferred edition deluxe avoid 版 優先',
	updates: 'github stable beta APK 自動更新 ベータ',
	about: 'version connected server バージョン'
};
const subsections: Entry[] = [
	{
		page: 'themes',
		label: 'Edit or share theme',
		anchor: 'theme-sharing',
		terms: 'import export JSON colors 共有 色'
	},
	{
		page: 'interface',
		label: 'Button and panel style',
		anchor: 'interface-material',
		terms: 'glass blur solid theme color ガラス ぼかし'
	},
	{
		page: 'interface',
		label: 'Screen transitions',
		anchor: 'interface-motion',
		terms: 'animation quick gentle アニメーション'
	},
	{ page: 'interface', label: 'Start screen', anchor: 'interface-start', account: true },
	{
		page: 'interface',
		label: 'Navigation bar',
		anchor: 'interface-navigation',
		terms: 'docked floating tabs destinations タブ フローティング'
	},
	{
		page: 'interface',
		label: 'Mini-player',
		anchor: 'mini-player-settings',
		terms: 'cover progress previous next secondary text ミニプレーヤー',
		account: true
	},
	{
		page: 'playback',
		label: 'Wi-Fi stream quality',
		anchor: 'stream-wifi',
		terms: 'bitrate transcode format codec streaming ビットレート 変換 音質'
	},
	{
		page: 'playback',
		label: 'Cellular stream quality',
		anchor: 'stream-cellular',
		terms: 'mobile data bitrate transcode format codec モバイル 通信 音質'
	},
	{
		page: 'playback',
		label: 'Audio playback',
		anchor: 'audio-playback',
		terms: 'speed volume normalization ReplayGain 再生速度 音量'
	},
	{
		page: 'playback',
		label: 'Track fades',
		anchor: 'track-fades-settings',
		terms:
			'smart fade in fade out transitions duration fallback manual クロスフェード フェードイン フェードアウト スマートフェード 代替 手動'
	},
	{
		page: 'offline',
		label: 'Playback cache',
		anchor: 'offline-playback',
		terms: 'offline only Wi-Fi rolling size storage オフライン キャッシュ'
	},
	{
		page: 'offline',
		label: 'Queue read-ahead',
		anchor: 'queue-read-ahead',
		native: true,
		terms:
			'upcoming precache preload wifi mobile cellular tracks upcoming songs 先読み 事前読み込み'
	},
	{
		page: 'offline',
		label: 'Download quality',
		anchor: 'download-quality',
		native: true,
		terms: 'format bitrate quality transcoding 形式 音質'
	},
	{
		page: 'offline',
		label: 'Automatic downloads',
		anchor: 'auto-download-options',
		terms: 'pins favorites playlist rules size budget 同期 自動ダウンロード'
	},
	{
		page: 'offline',
		label: 'Complete downloads',
		anchor: 'complete-downloads',
		native: true,
		terms: 'download album covers lyrics waveform ダウンロード ジャケット 歌詞 波形'
	},
	{
		page: 'offline',
		label: 'Refresh saved metadata',
		anchor: 'offline-metadata-refresh',
		native: true,
		terms: 'repair update tags offline titles rating メタデータ 更新'
	},
	{
		page: 'offline',
		label: 'Device diagnostics report',
		anchor: 'offline-diagnostics',
		native: true,
		terms: 'export share private privacy troubleshooting diagnostics 診断 プライバシー'
	},
	{
		page: 'offline',
		label: 'Cover artwork',
		anchor: 'artwork-cache-settings',
		terms: 'viewed images cache ジャケット 画像'
	},
	{
		page: 'offline',
		label: 'Lyrics',
		anchor: 'lyrics-cache-settings',
		terms: 'viewed lyrics cache 歌詞'
	},
	{
		page: 'offline',
		label: 'Download notifications',
		anchor: 'download-notifications',
		native: true,
		terms: 'background notification 通知'
	},
	{
		page: 'offline',
		label: 'Offline listening history',
		anchor: 'offline-listening',
		native: true,
		terms: 'scrobble history 再生履歴'
	},
	{
		page: 'equalizer',
		label: 'Frequency bands',
		anchor: 'equalizer-bands',
		terms: 'EQ gain bass treble preset 周波数 低音 高音'
	}
];
const publicPages = new Set<Page>(['themes', 'interface', 'language', 'updates', 'about']);
const adminPages = new Set<Page>(['diagnostics', 'scans', 'releases', 'editions']);
const entries: Entry[] = [
	...(Object.keys(pageTitles) as Page[]).map((page) => ({
		page,
		label: pageTitles[page],
		terms: groups[page]
	})),
	...subsections
];

function normalize(value: string) {
	return value
		.normalize('NFKC')
		.toLocaleLowerCase()
		.replace(/[‐‑–—-]/g, ' ')
		.trim();
}
export function findSettings(query: string, access: Access) {
	const words = normalize(query).split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	return entries.filter(({ page, label, terms, account, native }) => {
		if ((!access.signedIn && !publicPages.has(page)) || (adminPages.has(page) && !access.admin))
			return false;
		if (page === 'updates' && !access.android) return false;
		if ((page === 'equalizer' || native) && !access.android && !access.ios) return false;
		if ((page === 'handoff' || account) && !access.account) return false;
		if (
			(page === 'outputs' && !(access.android || access.ios)) ||
			(page === 'offline' && !access.offline)
		)
			return false;
		const text = normalize(
			[label, japaneseText(label), pageTitles[page], japaneseText(pageTitles[page]), terms].join(
				' '
			)
		);
		return words.every((word) => text.includes(word));
	});
}
