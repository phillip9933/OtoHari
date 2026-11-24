<script lang="ts">
	import { Browser } from '@capacitor/browser';
	import { onDestroy } from 'svelte';
	import { DnError, getJson, mutateJson, postJson, type Session } from '../connection';
	import { tr, uiText } from '../i18n';
	import { errorMessage } from '../catalog/catalog';
	import { forgetPickObservations } from '../catalog/discoverInteractions';
	import { forgetDiscoveryPage } from '../catalog/discoveryWidgets';
	import PlaylistDialog from '../catalog/PlaylistDialog.svelte';

	let { session }: { session: Session } = $props();
	type History = {
		state?: 'pending' | 'exporting' | 'importing' | 'current' | 'failed' | 'forgotten' | null;
		plays: number;
		imported_listens: number;
		account?: string | null;
		last_synced_at?: number | null;
		source?: 'upload' | 'export' | null;
	};
	const historyPath = '/api/v3/me/listening-history';
	let expanded = $state(false),
		busy = $state(false),
		unsupported = $state(false),
		linked = $state(false),
		confirm = $state(false),
		error = $state(''),
		message = $state('');
	let history = $state<History>();
	const controller = new AbortController();
	onDestroy(() => controller.abort());
	const importing = $derived(
		history?.state === 'pending' || history?.state === 'exporting' || history?.state === 'importing'
	);
	const retryable = $derived(history?.state === 'forgotten' || history?.state === 'failed');

	async function check() {
		try {
			history = await getJson<History>(session, historyPath, controller.signal);
		} catch (e) {
			if (e instanceof DnError && [404, 405].includes(e.status)) {
				unsupported = true;
				return;
			}
			throw e;
		}
		if (history.state === 'forgotten' || history.state === 'failed') {
			const links = await getJson<{ connections: { service: string }[] }>(
				session,
				'/api/v3/me/connections',
				controller.signal
			);
			linked = links.connections.some((link) => link.service === 'listenbrainz');
		}
	}
	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = message = '';
		try {
			await action();
		} catch (e) {
			if (!controller.signal.aborted) error = errorMessage(e);
		} finally {
			busy = false;
		}
	}
	function toggle() {
		expanded = !expanded;
		if (expanded && !unsupported) void run(check);
	}
	$effect(() => {
		if (!expanded || !importing) return;
		const timer = setInterval(() => {
			if (!document.hidden && !busy) void run(check);
		}, 30_000);
		return () => clearInterval(timer);
	});
	async function forget() {
		await mutateJson(session, '/api/v3/discover/history', 'DELETE');
		forgetDiscoveryPage(session);
		forgetPickObservations(session);
		confirm = false;
		await check();
		message = tr('Discover history forgotten.', 'おすすめ履歴を削除しました。');
	}
	async function importAgain() {
		history = await postJson<History>(
			session,
			historyPath + '/import',
			undefined,
			controller.signal
		);
	}
</script>

<button class="settings-entry" aria-expanded={expanded} onclick={toggle}>
	{tr('Discover history', 'おすすめ履歴')}
</button>
{#if expanded}
	<section
		class="settings-panel"
		aria-label={tr('Discover history', 'おすすめ履歴')}
		aria-busy={busy}
	>
		{#if unsupported}
			<p>
				{tr(
					'This DroppedNeedle version does not share Discover history controls.',
					'このバージョンのDroppedNeedleは、おすすめ履歴の管理に対応していません。'
				)}
			</p>
		{:else if history}
			<p>
				{tr('Plays in DroppedNeedle', 'DroppedNeedleの再生回数')} · {history.plays.toLocaleString()}
			</p>
			<p>
				{tr('Imported listens from ListenBrainz', 'ListenBrainzから取り込んだ再生履歴')} · {history.imported_listens.toLocaleString()}
			</p>
			{#if history.account}<p>ListenBrainz · {history.account}</p>{/if}
			{#if history.last_synced_at}<p>
					{tr('Last checked', '最終確認')} · {new Date(
						history.last_synced_at * 1000
					).toLocaleString()}
				</p>{/if}
			{#if importing}<p>{tr('Import in progress.', '取り込み中です。')}</p>
			{:else if history.state === 'failed'}<p>
					{tr('The last import failed.', '前回の取り込みに失敗しました。')}
				</p>
			{:else if history.state === 'forgotten'}<p>
					{tr(
						'Automatic imports are paused until you choose to import again.',
						'再度取り込むまでは自動取り込みを一時停止します。'
					)}
				</p>{/if}
			{#if retryable && linked}<button
					class="secondary"
					disabled={busy}
					onclick={() => run(importAgain)}
					>{tr('Import again from ListenBrainz', 'ListenBrainzから再度取り込む')}</button
				>{/if}
			<button class="text-button" disabled={busy} onclick={() => run(check)}
				>{tr('Refresh history status', '履歴の状態を更新')}</button
			>
			<button
				class="text-button"
				disabled={busy}
				onclick={() => run(() => Browser.open({ url: session.serverUrl + '/profile#scrobbling' }))}
				>{tr(
					'Upload a ListenBrainz ZIP in DroppedNeedle',
					'DroppedNeedleでListenBrainzのZIPをアップロード'
				)}</button
			>
			<button
				class="text-button"
				disabled={busy}
				onclick={() => {
					error = '';
					confirm = true;
				}}>{tr('Forget Discover history', 'おすすめ履歴を削除')}</button
			>
		{/if}
		{#if error && !confirm}<p role="alert">{error}</p>
			{#if !history}<button class="text-button" disabled={busy} onclick={() => run(check)}
					>{uiText('Retry')}</button
				>{/if}
		{/if}
		{#if message}<p role="status">{message}</p>{/if}
	</section>
{/if}
{#if confirm}
	<PlaylistDialog
		title={tr('Forget your Discover history?', 'おすすめ履歴を削除しますか？')}
		{busy}
		onclose={() => (confirm = false)}
	>
		<p>
			{tr(
				'This removes past recommendations, play endings and imported ListenBrainz history for this account across devices. Your library, play counts and explicit Discover feedback stay. Future imports must be restarted manually.',
				'すべての端末で、このアカウントの過去のおすすめ、再生の終了状況、取り込んだListenBrainz履歴を削除します。ライブラリ、再生回数、おすすめへのフィードバックは残ります。取り込みを再開するには手動で操作してください。'
			)}
		</p>
		{#if error}<p role="alert">{error}</p>{/if}
		<button class="secondary" disabled={busy} onclick={() => (confirm = false)}
			>{uiText('Cancel')}</button
		>
		<button class="primary" disabled={busy} onclick={() => run(forget)}
			>{tr('Confirm forget history', '履歴の削除を確定')}</button
		>
	</PlaylistDialog>
{/if}
