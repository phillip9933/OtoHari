<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { nativeDocuments } from '../documentFiles';
	import type { Session } from '../connection';
	import { tr } from '../i18n';
	import { nativeMedia } from './nativeMedia';

	let { session }: { session: Session } = $props();
	const destinations = Capacitor.getPlatform() === 'ios' ? nativeDocuments : nativeMedia;
	let operation = $state(''),
		message = $state(''),
		problem = $state(''),
		report = $state('');
	$effect(() => {
		void session.userId;
		void session.serverUrl;
		report = '';
		message = '';
		problem = '';
	});
	async function act(kind: 'review' | 'save' | 'share') {
		if (operation || !session.userId) return;
		const account = { serverUrl: session.serverUrl, userId: session.userId };
		const sameAccount = () =>
			account.serverUrl === session.serverUrl && account.userId === session.userId;
		operation = kind;
		message = '';
		problem = '';
		try {
			if (kind === 'review') {
				const result = await nativeMedia.diagnostics(account);
				if (sameAccount()) report = result.text;
			} else if (kind === 'save') {
				const { saved } = await destinations.saveDiagnostics({ ...account, text: report });
				if (saved && sameAccount()) message = tr('Report saved.', 'レポートを保存しました。');
			} else await destinations.shareDiagnostics({ ...account, text: report });
		} catch {
			if (sameAccount())
				problem = tr(
					'Could not export the report. Review it again and retry.',
					'レポートを開けませんでした。内容を再確認してお試しください。'
				);
		} finally {
			operation = '';
		}
	}
</script>

<h2 id="offline-diagnostics">{tr('Device diagnostic report', '端末の診断レポート')}</h2>
<fieldset class="settings-panel" data-surface="panel" aria-labelledby="offline-diagnostics">
	<p>
		{tr(
			'Review device and connection information, cache totals and pending activity before saving or sharing a copy.',
			'端末・接続情報、キャッシュの合計、保留中の処理を確認してから、レポートを保存または共有できます。'
		)}
	</p>
	<button class="secondary" disabled={!session.userId || !!operation} onclick={() => act('review')}
		>{tr('Review report', 'レポートを確認')}</button
	>
	{#if report}
		<pre>{report}</pre>
		<div class="settings-actions">
			<button class="secondary" disabled={!!operation} onclick={() => act('save')}
				>{tr('Save file', 'ファイルを保存')}</button
			>
			<button class="secondary" disabled={!!operation} onclick={() => act('share')}
				>{tr('Share report', 'レポートを共有')}</button
			>
			<button class="secondary" disabled={!!operation} onclick={() => (report = '')}
				>{tr('Close', '閉じる')}</button
			>
		</div>
	{/if}
</fieldset>
{#if message}<p role="status">{message}</p>{/if}
{#if problem}<p role="alert">{problem}</p>{/if}

<style>
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 0.82rem;
	}
	.settings-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
</style>
