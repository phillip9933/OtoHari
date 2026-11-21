<script lang="ts">
	import { online } from 'svelte/reactivity/window';
	import { tr } from '../i18n';
	import type { Session } from '../connection';
	import { refreshOfflineMetadata } from './companions';
	import { onDestroy } from 'svelte';

	let { session, disabled }: { session: Session; disabled: boolean } = $props();
	let refreshing = $state(false),
		message = $state(''),
		problem = $state('');
	const refresh = new AbortController();
	onDestroy(() => refresh.abort());

	async function refreshDetails() {
		if (refreshing || disabled || !session.userId || !online.current) return;
		const account = { serverUrl: session.serverUrl, userId: session.userId };
		const sameAccount = () =>
			session.serverUrl === account.serverUrl && session.userId === account.userId;
		refreshing = true;
		message = problem = '';
		try {
			const result = await refreshOfflineMetadata(session, refresh.signal);
			if (sameAccount())
				message = tr(
					`Updated ${result.updated} ${result.updated === 1 ? 'track' : 'tracks'}. ${result.unavailable} unavailable on DN.`,
					`${result.updated} 曲を更新しました。DN で見つからない曲は ${result.unavailable} 曲です。`
				);
		} catch {
			if (sameAccount())
				problem = tr(
					'Could not refresh the saved music. Check the DN connection and try again.',
					'保存した曲を更新できませんでした。DN への接続を確認してください。'
				);
		} finally {
			refreshing = false;
		}
	}
</script>

<h2 id="offline-metadata-refresh">{tr('Saved music details', '保存した曲の情報')}</h2>
<fieldset class="settings-panel" data-surface="panel" aria-labelledby="offline-metadata-refresh">
	<p>
		{tr(
			'Refresh titles, artists, artwork, lyrics and ratings from DN. Local edits waiting to sync stay on this device.',
			'DN の曲名、アーティスト、アートワーク、歌詞と評価を更新します。同期待ちの変更は端末に保持されます。'
		)}
	</p>
	<button
		class="secondary"
		disabled={!session.userId || refreshing || disabled || !online.current}
		onclick={refreshDetails}
	>
		{refreshing
			? tr('Refreshing…', '更新中…')
			: tr('Refresh saved music', '保存した曲を更新')}</button
	>
</fieldset>
{#if message}<p role="status">{message}</p>{/if}
{#if problem}<p role="alert">{problem}</p>{/if}
