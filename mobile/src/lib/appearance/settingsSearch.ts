import { japaneseText } from '../locales/japaneseText';

const appearance = 'Appearance & layout';
const playback = 'Playback';
const downloads = 'Downloads & storage';
const admin = 'Server administration';

const pages = {
	home: [appearance, 'Home layout'],
	library: [appearance, 'Library layout'],
	discover: [appearance, 'Discover layout'],
	player: [appearance, 'Now Playing layout'],
	mini: [appearance, 'Mini-player'],
	themes: [appearance, 'Themes'],
	interface: [appearance, 'Button style and transitions'],
	navigation: [appearance, 'Navigation bar and start screen'],
	playback: [playback, 'Streaming quality'],
	fades: [playback, 'Track fades'],
	sound: [playback, 'Sound'],
	outputs: [playback, 'Cast and audio output'],
	handoff: [playback, 'Player handoff'],
	offline: [downloads, 'Offline mode and playback cache'],
	downloads: [downloads, 'Download preferences'],
	storage: [downloads, 'Device storage'],
	stats: ['Library', 'Library statistics'],
	account: ['Account', 'Account on DroppedNeedle'],
	content: ['Account', 'Account-wide content visibility'],
	history: ['Account', 'Offline listening history'],
	language: ['App', 'App language'],
	updates: ['App', 'App updates'],
	troubleshooting: ['App', 'Troubleshooting'],
	tools: ['App', 'Open in DN web app'],
	about: ['App', 'About'],
	diagnostics: [admin, 'Server diagnostics'],
	scans: [admin, 'Library health and scans'],
	releases: [admin, 'Release types'],
	editions: [admin, 'Edition preferences']
} as const;
type Page = keyof typeof pages;
export type SettingsPage = Exclude<Page, 'outputs'> | 'menu';
export const pageTitles = Object.fromEntries(
	Object.entries(pages).map(([id, [, title]]) => [id, title])
) as Record<Page, string>;

type Access = {
	signedIn: boolean;
	account: boolean;
	admin: boolean;
	android: boolean;
	ios: boolean;
	offline: boolean;
};

type Target = { page: Page } | { page: 'menu'; section: string };
type Entry = Target & {
	label: string;
	anchor?: string;

	terms?: string;
	// Old labels remain searchable in both interface languages.
	was?: string;
	deviceOnly?: boolean;
	accountOnly?: boolean;
};

const keywords: Partial<Record<Page, string>> = {
	home: 'pins pin to home sections shelves ホーム ピン',
	library: 'filters sections shelves フィルター',
	discover: 'sections shelves 表示',
	player: 'composer grid buttons artwork rows columns lyrics 歌詞 ボタン 配置',
	mini: 'cover progress previous next secondary text ミニプレーヤー',
	themes: 'colors palette dark light midnight custom CSS テーマ 配色',
	handoff: 'remote control device transfer 引き継ぎ',
	account:
		'profile username sessions devices connected services email scrobble last.fm プロフィール',
	content: 'home discover web sidebar sections サイドバー',
	tools: 'browser web tools administration ウェブ',
	stats: 'statistics totals library 統計',
	diagnostics: 'server workload jobs limits サーバー 診断',
	scans: 'health refresh library scans スキャン',
	releases: 'album EP singles アルバム シングル',
	editions: 'preferred edition deluxe avoid 版 優先',
	updates: 'github stable beta APK 自動更新 ベータ',
	language: 'English Japanese 日本語 英語 言語 system locale',
	about: 'version connected server バージョン'
};
const formerNames: Partial<Record<Page, string>> = {
	home: 'Edit Home layout',
	library: 'Edit Library layout',
	discover: 'Edit Discover layout',
	player: 'Edit Now Playing layout',
	mini: 'Interface and navigation',
	interface: 'Interface and navigation',
	navigation: 'Interface and navigation',
	playback: 'Streaming and fades',
	fades: 'Streaming and fades',
	sound: 'Streaming and fades',
	offline: 'Offline and cache',
	downloads: 'Offline and cache',
	storage: 'Offline and cache',
	content: 'Content preferences',
	tools: 'Web tools'
};
const controls: Entry[] = [
	{
		page: 'themes',
		label: 'Album artwork colors',
		anchor: 'theme-artwork',
		terms: 'automatic dynamic background cover tint now playing 自動 背景 アートワーク'
	},
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
		terms: 'animation quick gentle motion アニメーション'
	},
	{
		page: 'navigation',
		label: 'Navigation bar',
		anchor: 'interface-navigation',
		terms: 'docked floating tabs destinations タブ フローティング'
	},
	{
		page: 'navigation',
		label: 'Start screen',
		anchor: 'interface-start',
		accountOnly: true,
		terms: 'launch startup 起動'
	},
	{
		page: 'playback',
		label: 'Wi-Fi stream quality',
		anchor: 'stream-wifi',
		terms: 'wifi wireless bitrate transcode format codec streaming ビットレート 変換 音質'
	},
	{
		page: 'playback',
		label: 'Cellular stream quality',
		anchor: 'stream-cellular',
		terms: 'mobile data bitrate transcode format codec streaming モバイル 通信 音質'
	},
	{
		page: 'fades',
		label: 'Smart fades',
		anchor: 'smart-fades',
		terms: 'crossfade transitions automatic クロスフェード'
	},
	{
		page: 'fades',
		label: 'Fade in',
		anchor: 'fade-in',
		terms: 'manual fallback duration 代替 手動'
	},
	{
		page: 'fades',
		label: 'Fade out',
		anchor: 'fade-out',
		terms: 'manual fallback duration 代替 手動'
	},
	{
		page: 'sound',
		label: 'Playback speed',
		anchor: 'playback-speed',
		was: 'Audio playback',
		terms: 'tempo speed rate 速度'
	},
	{
		page: 'sound',
		label: 'Volume normalization',
		anchor: 'volume-normalization',
		was: 'Audio playback',
		deviceOnly: true,
		terms: 'ReplayGain track album gain 音量'
	},
	{
		page: 'sound',
		label: 'Equalizer',
		anchor: 'sound-equalizer',
		deviceOnly: true,
		terms: 'EQ presets headphones イコライザー イヤホン'
	},
	{
		page: 'sound',
		label: 'Frequency bands',
		anchor: 'equalizer-bands',
		deviceOnly: true,
		terms: 'EQ equalizer bass treble gain 周波数 低音 高音'
	},
	{
		page: 'menu',
		section: playback,
		label: 'Autoplay when the queue ends',
		anchor: 'queue-autoplay',
		was: 'Queue and autoplay',
		terms:
			'autoplay similar library music extend playback up next 自動再生 関連する曲 似ている曲 再生を延長'
	},
	{
		page: 'offline',
		label: 'Offline mode',
		anchor: 'offline-mode',
		was: 'Play only offline music',
		terms: 'offline only airplane disconnected オフラインのみ 機内モード'
	},
	{
		page: 'offline',
		label: 'Cache songs during playback',
		anchor: 'cache-played-songs',
		terms: 'rolling automatic played tracks cache 再生済みの曲 キャッシュ'
	},
	{
		page: 'offline',
		label: 'Playback cache limit',
		anchor: 'playback-cache-limit',
		terms: 'size space storage budget キャッシュ 容量 上限'
	},
	{
		page: 'offline',
		label: 'Cache upcoming songs',
		anchor: 'queue-read-ahead',
		was: 'Queue read-ahead',
		deviceOnly: true,
		terms: 'precache prefetch preload wifi mobile cellular upcoming tracks 先読み 事前読み込み'
	},
	{
		page: 'downloads',
		label: 'Download network',
		anchor: 'download-network',
		deviceOnly: true,
		terms:
			'wifi unmetered metered cellular mobile data networks ダウンロード時のネットワーク 非従量制回線'
	},
	{
		page: 'downloads',
		label: 'Download quality',
		anchor: 'download-quality',
		deviceOnly: true,
		terms: 'format bitrate transcoding offline audio 形式 音質'
	},
	{
		page: 'downloads',
		label: 'Automatic downloads',
		anchor: 'auto-download-options',
		terms: 'favorites playlist rules size budget 同期 自動ダウンロード'
	},
	{
		page: 'downloads',
		label: 'Keep a collection offline',
		anchor: 'keep-collection-offline',
		was: 'Pin a collection',
		deviceOnly: true,
		terms: 'pins playlist album artist keep downloaded 保存 ピン留め'
	},
	{
		page: 'downloads',
		label: 'Include artwork, lyrics & waveforms',
		anchor: 'complete-downloads',
		was: 'Complete downloads',
		deviceOnly: true,
		terms: 'download album covers lyrics waveform ダウンロード ジャケット 歌詞 波形'
	},
	{
		page: 'downloads',
		label: 'Download notifications',
		anchor: 'download-notifications',
		deviceOnly: true,
		terms: 'background notification 通知'
	},
	{
		page: 'storage',
		label: 'On this device',
		anchor: 'device-storage',
		terms: 'space storage usage disk size 管理 空き容量 使用量'
	},
	{
		page: 'storage',
		label: 'Cover artwork',
		anchor: 'artwork-cache-settings',
		terms: 'viewed images cache limit clear ジャケット 画像'
	},
	{
		page: 'storage',
		label: 'Lyrics',
		anchor: 'lyrics-cache-settings',
		terms: 'viewed lyrics cache limit clear 歌詞'
	},
	{
		page: 'storage',
		label: 'Refresh saved music',
		anchor: 'offline-metadata-refresh',
		was: 'Refresh saved metadata',
		deviceOnly: true,
		terms: 'repair update tags offline titles rating メタデータ 更新'
	},
	{
		page: 'troubleshooting',
		label: 'Device diagnostic report',
		anchor: 'offline-diagnostics',
		was: 'Device diagnostics report',
		terms: 'export share private privacy troubleshooting diagnostics 診断 プライバシー'
	},
	{
		page: 'history',
		label: 'Record offline listens',
		anchor: 'offline-listening',
		terms: 'scrobble history pending sync 再生履歴'
	},
	{
		page: 'menu',
		section: 'Account',
		label: 'Sign out',
		anchor: 'account-sign-out',
		terms: 'logout log out logoff disconnect サインアウト ログアウト'
	}
];
const pageEntries: Entry[] = (Object.keys(pages) as Page[]).map((page) => ({
	page,
	label: pageTitles[page],
	terms: keywords[page],
	was: formerNames[page]
}));
const entries = [...pageEntries, ...controls];
const publicPages = new Set<Page>([
	'themes',
	'interface',
	'navigation',
	'language',
	'updates',
	'about'
]);
const offlinePages = new Set<Page>([
	'offline',
	'downloads',
	'storage',
	'history',
	'troubleshooting'
]);

function available(entry: Entry, access: Access) {
	const { page } = entry;
	const supportedDevice = access.android || access.ios;
	if (!(access.signedIn || (page !== 'menu' && publicPages.has(page)))) return false;
	if (page !== 'menu' && pages[page][0] === admin && !access.admin) return false;
	if (page !== 'menu' && offlinePages.has(page) && !access.offline) return false;
	if (
		(entry.accountOnly ||
			page === 'mini' ||
			page === 'handoff' ||
			page === 'history' ||
			page === 'troubleshooting') &&
		!access.account
	)
		return false;
	if ((entry.deviceOnly || page === 'history' || page === 'troubleshooting') && !supportedDevice)
		return false;
	if (page === 'updates' && !access.android) return false;
	if (page === 'outputs' && !access.android && !access.ios) return false;

	return true;
}

function normalize(value: string) {
	return value
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[‐‑‒–—-]/g, ' ')
		.replace(/wi\s*fi/g, 'wifi')
		.replace(/\s+/g, ' ')
		.trim();
}

function matchRank(labels: string[], query: string, words: string[]) {
	if (labels.includes(query)) return 0;
	if (labels.some((label) => label.startsWith(query))) return 1;
	if (labels.some((label) => words.every((word) => label.includes(word)))) return 2;
	return 3;
}

export function findSettings(query: string, access: Access) {
	const search = normalize(query);
	if (!search) return [];
	const words = search.split(' ');
	return entries
		.flatMap((entry) => {
			if (!available(entry, access)) return [];
			const breadcrumb = entry.page === 'menu' ? [entry.section] : [pages[entry.page][0]];
			if (entry.anchor && entry.page !== 'menu') breadcrumb.push(pageTitles[entry.page]);
			const labels = [entry.label, japaneseText(entry.label)].map(normalize);
			let terms = entry.terms ?? '';
			if (entry.page === 'outputs')
				terms += access.ios
					? ' AirPlay speaker スピーカー'
					: ' Chromecast DLNA Sonos speaker スピーカー';
			const searchable = normalize(
				[
					...labels,
					terms,
					...(entry.was ? [entry.was, japaneseText(entry.was)] : []),
					...breadcrumb.flatMap((step) => [step, japaneseText(step)])
				].join(' ')
			);
			if (!words.every((word) => searchable.includes(word))) return [];
			const rank = matchRank(labels, search, words);
			return [{ ...entry, breadcrumb, rank }];
		})
		.sort((a, b) => a.rank - b.rank);
}
