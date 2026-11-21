<script lang="ts">
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { tr } from '../i18n';
	import type { OfflineOptions } from './tracks';
	let {
		options,
		change,
		busy
	}: {
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
	const counts = [0, 1, 2, 3, 5, 10, 20],
		rates = [0, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
</script>

<h2 id="queue-read-ahead">{tr('Cache upcoming songs', '次の曲をキャッシュ')}</h2>
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
