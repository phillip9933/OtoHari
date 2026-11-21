<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { onDestroy } from 'svelte';
	import { nativeDocuments } from '../documentFiles';
	import { online } from 'svelte/reactivity/window';
	import type { Session } from '../connection';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { tr } from '../i18n';
	import { refreshOfflineMetadata } from './companions';
	import { nativeMedia } from './nativeMedia';
	import type { OfflineOptions } from './tracks';

	let {
		session,
		options,
		change,
		busy
	}: {
		session: Session;
		options: OfflineOptions;
		change: (value: OfflineOptions) => Promise<void>;
		busy: boolean;
	} = $props();
	const connections = [
		{ count: 'readAheadWifi', rate: 'readAheadWifiKiBps', name: () => tr('Wi-Fi', 'Wi-Fi') },
		{
			count: 'readAheadCellular',
			rate: 'readAheadCellularKiBps',
			name: () => tr('Cellular', 'モバイル回線')
		}
	] as const;
	let refresh = new AbortController();
	onDestroy(() => refresh.abort());
	const destinations = Capacitor.getPlatform() === 'ios' ? nativeDocuments : nativeMedia;
	const counts = [0, 1, 2, 3, 5, 10, 20],
		rates = [0, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
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
	async function act(kind: 'refresh' | 'review' | 'save' | 'share') {
		if (operation || !session.userId) return;
		const account = { serverUrl: session.serverUrl, userId: session.userId };
		const sameAccount = () =>
			account.serverUrl === session.serverUrl && account.userId === session.userId;
		operation = kind;
		message = '';
		problem = '';
		try {
			if (kind === 'refresh') {
				refresh.abort();
				refresh = new AbortController();
				const result = await refreshOfflineMetadata(session, refresh.signal);
				if (sameAccount())
					message = tr(
						`Updated ${result.updated} ${result.updated === 1 ? 'track' : 'tracks'}. ${result.unavailable} unavailable on DN.`,
						`${result.updated} 曲を更新しました。DN で見つからない曲は ${result.unavailable} 曲です。`
					);
			} else if (kind === 'review') {
				const result = await nativeMedia.diagnostics(account);
				if (sameAccount()) report = result.text;
			} else if (kind === 'save') {
				const { saved } = await destinations.saveDiagnostics({ ...account, text: report });
				if (saved && sameAccount()) message = tr('Report saved.', 'レポートを保存しました。');
			} else await destinations.shareDiagnostics({ ...account, text: report });
		} catch {
			if (sameAccount())
				problem =
					kind === 'refresh'
						? tr(
								'Could not refresh the saved music. Check the DN connection and try again.',
								'保存した曲を更新できませんでした。DN への接続を確認してください。'
							)
						: tr(
								'Could not export the report. Review it again and retry.',
								'レポートを開けませんでした。内容を再確認してお試しください。'
							);
		} finally {
			operation = '';
		}
	}
</script>

<h2 id="queue-read-ahead">{tr('Queue read-ahead', 'キューの先読み')}</h2>
<fieldset
	class="settings-panel"
	data-surface="panel"
	aria-labelledby="queue-read-ahead"
	disabled={busy}
>
	<p>
		{tr(
			'While music plays on this device, save upcoming songs at the streaming quality for this connection. They share the playback cache limit.',
			'端末での再生中に、次の曲を現在の回線のストリーミング音質で保存します。再生キャッシュの容量を使用します。'
		)}
	</p>
	{#each connections as connection (connection.count)}
		<label>
			{tr(`${connection.name()} tracks ahead`, `${connection.name()} で先読みする曲数`)}
			<InlineChoice selected={options[connection.count] ?? 0}>
				<select
					value={options[connection.count] ?? 0}
					onchange={(event) =>
						change({ ...options, [connection.count]: Number(event.currentTarget.value) })}
				>
					{#each counts as n (n)}<option value={n}>{n || tr('Off', 'オフ')}</option>{/each}
				</select>
			</InlineChoice>
		</label>
		{#if options[connection.count]}
			<label>
				{tr(`${connection.name()} read-ahead speed`, `${connection.name()} の先読み速度`)}
				<InlineChoice selected={options[connection.rate] ?? 0}>
					<select
						value={options[connection.rate] ?? 0}
						onchange={(event) =>
							change({ ...options, [connection.rate]: Number(event.currentTarget.value) })}
					>
						{#each rates as n (n)}<option value={n}
								>{n ? n + ' KiB/s' : tr('Unlimited', '制限なし')}</option
							>{/each}
					</select>
				</InlineChoice>
			</label>
		{/if}
	{/each}
	{#if options.readAheadCellular}
		<p>
			{tr(
				'Cellular read-ahead uses mobile data, including when downloads are limited to unmetered networks.',
				'ダウンロードを非従量制回線に制限している場合も、モバイル回線の先読みはモバイルデータを使用します。'
			)}
		</p>
	{/if}
</fieldset>
<h2 id="complete-downloads">{tr('Complete downloads', 'オフライン用データ')}</h2>
<fieldset
	class="settings-panel"
	data-surface="panel"
	aria-labelledby="complete-downloads"
	disabled={busy}
>
	<label
		><input
			type="checkbox"
			checked={options.completeDownloads ?? true}
			onchange={(e) => change({ ...options, completeDownloads: e.currentTarget.checked })}
		/>
		{tr(
			'Save artwork and lyrics with downloads',
			'ダウンロード時にアートワークと歌詞を保存'
		)}</label
	>
	{#if options.completeDownloads ?? true}
		<label
			><input
				type="checkbox"
				checked={options.downloadWaveforms ?? false}
				onchange={(e) => change({ ...options, downloadWaveforms: e.currentTarget.checked })}
			/>
			{tr('Prepare waveforms from downloaded audio', '保存した音声から波形を作成')}</label
		>
	{/if}
</fieldset>
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
		disabled={!session.userId || !!operation || busy || !online.current || options.offlineOnly}
		onclick={() => act('refresh')}
	>
		{operation === 'refresh'
			? tr('Refreshing…', '更新中…')
			: tr('Refresh saved music', '保存した曲を更新')}</button
	>
</fieldset>
<h2 id="offline-diagnostics">{tr('Diagnostic report', '診断レポート')}</h2>
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
