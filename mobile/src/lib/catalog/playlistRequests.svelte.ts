import { playBuild } from '../distribution';
import { SvelteMap } from 'svelte/reactivity';
import { DnError, getJson, postJson, type Session } from '../connection';
import { tr } from '../i18n';
import { errorMessage, path } from './catalog';

type EntryState = keyof typeof states;
const states = {
	requestable: ['Available to request', 'リクエスト可能'],
	no_album_yet: ['No album found yet', 'アルバム未特定'],
	finding_album: ['Finding album', 'アルバムを検索中'],
	awaiting_approval: ['Awaiting approval', '承認待ち'],
	downloading: ['Downloading', 'ダウンロード中'],
	awaiting_review: ['Awaiting review', '確認待ち'],
	album_in_library: ['Album in library', 'アルバムはライブラリにあります'],
	rejected: ['Rejected', '却下済み']
} as const;
export function entryStatus(state: EntryState) {
	const [en, ja] = states[state] ?? ['Unavailable in library', 'ライブラリにありません'];
	return tr(en, ja);
}

type ImportStatus =
	| { state: 'running' }
	| {
			state: 'failed';
			reason: 'not_linked' | 'rate_limited' | 'unavailable' | 'save_failed' | 'other';
	  };
export function importStatus(status: ImportStatus) {
	if (status.state === 'running') return tr('Importing from Spotify…', 'Spotify からインポート中…');
	switch (status.reason) {
		case 'not_linked':
			return tr(
				'Reconnect Spotify in your DN profile to import this playlist.',
				'このプレイリストをインポートするには、DN のプロフィールで Spotify に再接続してください。'
			);
		case 'rate_limited':
			return tr(
				'Spotify is limiting import requests. Try again later.',
				'Spotify 側でインポートの回数が制限されています。しばらくしてからもう一度お試しください。'
			);
		case 'unavailable':
			return tr(
				'Spotify did not respond to the import.',
				'インポート時に Spotify から応答がありませんでした。'
			);
		case 'save_failed':
			return tr(
				'DN could not save the Spotify playlist.',
				'DN に Spotify のプレイリストを保存できませんでした。'
			);
		default:
			return tr('Spotify import failed.', 'Spotify からのインポートに失敗しました。');
	}
}
type RequestState = {
	entries: { entry_id: string; state: EntryState }[];
	requestable_albums: number;
	no_album_songs: number;
	finding_albums: boolean;
	import?: ImportStatus | null;
};
type Receipt = {
	requested: number;
	needs_approval: boolean;
	in_library: number;
	already_requested: number;
	rejected_before: number;
	over_quota: number;
	over_cap: number;
};
function albumReceipt(result: Receipt) {
	const lines = [
		tr(`Albums requested: ${result.requested}`, `リクエストしたアルバム：${result.requested}`)
	];
	if (result.requested && result.needs_approval) lines.push(tr('Awaiting approval', '承認待ち'));
	const counts = [
		[result.in_library, tr('Already in library', 'ライブラリに追加済み')],
		[result.already_requested, tr('Already requested', 'リクエスト済み')],
		[result.rejected_before, tr('Previously rejected', '却下済み')],
		[result.over_quota, tr('Over your quota', 'リクエスト枠の超過')],
		[result.over_cap, tr('Beyond the 200-album limit', 'アルバム200件の上限超過')]
	] as const;
	for (const [count, label] of counts) if (count) lines.push(`${label}: ${count}`);
	return lines.join(' · ');
}

export function playlistRequests(
	session: () => Session,
	id: () => string | undefined,
	onChange: () => void
) {
	let state = $state.raw<RequestState>();
	let readingError = $state('');
	let receipt = $state('');
	let actionError = $state('');
	let sending = $state(false);
	const entries = $derived(new SvelteMap(state?.entries.map((row) => [row.entry_id, row.state])));
	let refresh: (() => Promise<void>) | undefined;
	let act: ((song: boolean, entry?: string) => Promise<void>) | undefined;

	$effect(() => {
		const playlistId = id();
		const account = session();
		state = undefined;
		readingError = receipt = actionError = '';
		sending = false;
		if (playBuild || !playlistId) return;
		const base = path('/api/v3/playlists/{playlist_id}', { playlist_id: playlistId });
		const lifetime = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let reading = 0;
		let supported = true;
		const retryKeys = new SvelteMap<string, string>();
		const started = Date.now();

		async function read() {
			clearTimeout(timer);
			if (document.hidden || !supported || lifetime.signal.aborted) return;
			const revision = ++reading;
			try {
				const next = await getJson<RequestState>(account, base + '/request-state', lifetime.signal);
				if (lifetime.signal.aborted || revision !== reading) return;
				const prior = state;
				state = next;
				readingError = '';
				const working = next.finding_albums || next.import?.state === 'running';
				const pending = next.entries.some((row) =>
					['downloading', 'awaiting_review', 'awaiting_approval'].includes(row.state)
				);
				if (working || pending)
					timer = setTimeout(read, working && Date.now() - started < 60_000 ? 5_000 : 30_000);
				if (
					prior &&
					(next.entries.length < prior.entries.length ||
						(prior.finding_albums && !next.finding_albums) ||
						(prior.import?.state === 'running' && !working))
				)
					onChange();
			} catch (cause) {
				if (lifetime.signal.aborted || revision !== reading) return;
				if (cause instanceof DnError && [403, 404, 405].includes(cause.status)) {
					supported = false;
					state = undefined;
					readingError = '';
				} else readingError = errorMessage(cause);
			}
		}

		async function send(song: boolean, entry?: string) {
			if (sending || !state || !supported) return;
			sending = true;
			actionError = receipt = '';
			const target = entry ?? '';
			try {
				if (song && entry) {
					const result = await postJson<{ status: string }>(
						account,
						base + '/tracks/' + encodeURIComponent(entry) + '/request-song',
						undefined,
						lifetime.signal
					);
					receipt =
						result.status === 'awaiting_approval'
							? tr('Song awaiting approval', '曲の承認待ち')
							: tr('Song requested', '曲をリクエストしました');
				} else {
					const key = retryKeys.get(target) ?? crypto.randomUUID();
					retryKeys.set(target, key);
					const result = await postJson<Receipt>(
						account,
						base + '/request-missing',
						{
							idempotency_key: key,
							...(entry ? { entry_id: entry } : {})
						},
						lifetime.signal
					);
					retryKeys.delete(target);
					receipt = albumReceipt(result);
				}
				await read();
			} catch (cause) {
				if (lifetime.signal.aborted) return;
				// A lost reply may already have filed the albums. Retry that press with the same key.
				if (
					cause instanceof DnError &&
					cause.status >= 400 &&
					cause.status < 500 &&
					cause.status !== 408
				)
					retryKeys.delete(target);
				actionError = errorMessage(cause);
				if (cause instanceof DnError && [403, 404, 409].includes(cause.status)) await read();
			} finally {
				if (!lifetime.signal.aborted) sending = false;
			}
		}
		refresh = read;
		act = send;
		const visibility = () => {
			if (document.hidden) clearTimeout(timer);
			else void read();
		};
		document.addEventListener('visibilitychange', visibility);
		void read();
		return () => {
			lifetime.abort();
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', visibility);
			refresh = act = undefined;
		};
	});
	return {
		get state() {
			return state;
		},
		get entries() {
			return entries;
		},
		get readingError() {
			return readingError;
		},
		get actionError() {
			return actionError;
		},
		get receipt() {
			return receipt;
		},
		get sending() {
			return sending;
		},
		refresh: () => refresh?.(),
		album: (entry?: string) => act?.(false, entry),
		song: (entry: string) => act?.(true, entry)
	};
}
