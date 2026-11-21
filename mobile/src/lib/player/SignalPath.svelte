<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { tr } from '../i18n';
	import type { PlaybackDelivery, PlaybackFormat, PlayerTrack } from '../player';
	import { nativePlayer, type SignalOutput } from './native';
	import { browserSpeed } from './sound';

	let {
		track,
		quality,
		delivery
	}: { track: PlayerTrack; quality?: PlaybackFormat | null; delivery?: PlaybackDelivery } =
		$props();
	let output = $state<SignalOutput>({});
	const platform = Capacitor.getPlatform();
	$effect(() => {
		const id = track.id;
		let live = true,
			busy = false;
		output = {};
		async function read() {
			if (busy || document.hidden) return;
			busy = true;
			try {
				const details = Capacitor.isNativePlatform()
					? await nativePlayer.signalPath()
					: platform === 'web'
						? { id, speed: browserSpeed() }
						: {};
				if (live) output = details.id === id ? details : {};
			} catch {
				if (live) output = {};
			} finally {
				busy = false;
			}
		}
		void read();
		const poll = window.setInterval(read, 2000);
		return () => {
			live = false;
			window.clearInterval(poll);
		};
	});
	const unknown = $derived(tr('Not reported', '情報なし'));
	const opened = $derived(output.delivery ?? delivery);
	function origin(value: PlaybackDelivery['source']) {
		return {
			network: tr('Network stream', 'ネットワークストリーム'),
			device: tr('On this device', '端末上のファイル'),
			downloaded: tr('Manual download', '手動ダウンロード'),
			automatic: tr('Automatic download', '自動ダウンロード'),
			cached: tr('Playback cache', '再生キャッシュ')
		}[value];
	}
	const sampleRate = (hz: number) => Number((hz / 1000).toFixed(3)) + ' kHz';
	function format(codec?: string, sample?: number, depth?: number, bitrate?: number) {
		return [
			codec,
			sample && sampleRate(sample),
			depth && depth + '-bit',
			bitrate && bitrate + ' kbps'
		]
			.filter(Boolean)
			.join(' · ');
	}
	const device = $derived.by(() => {
		const kind = {
			speaker: tr('Phone speaker', '本体スピーカー'),
			earpiece: tr('Earpiece', '受話スピーカー'),
			wired: tr('Wired headphones', '有線ヘッドホン'),
			bluetooth: 'Bluetooth',
			usb: 'USB',
			hdmi: 'HDMI'
		};
		return (
			[output.route && kind[output.route], output.destination].filter(Boolean).join(' · ') ||
			unknown
		);
	});
</script>

<div class="path" data-part="signal-path">
	<section>
		<h3>{tr('Source file', '元ファイル')}</h3>
		<p>{track.title}</p>
		<p>
			{format(
				track.format?.toUpperCase(),
				track.sourceSampleRate,
				track.sourceBitDepth,
				track.sourceBitrate
			) || unknown}
		</p>
	</section>
	<section>
		<h3>{tr('Playing stream', '再生ストリーム')}</h3>
		<p>
			{!output.remote && quality
				? format(quality.format, quality.sampleRate, quality.bitDepth, quality.bitrate)
				: unknown}
		</p>
		{#if opened}
			<dl>
				<dt>{tr('Played from', '再生元')}</dt>
				<dd>{origin(opened.source)}</dd>
				{#if output.remote && opened.mime}<dt>
						{tr('Sent to receiver', 'キャスト先に送信した形式')}
					</dt>
					<dd>{opened.mime}</dd>{/if}
				{#if opened.profile}<dt>{tr('Stream profile', 'ストリーム設定')}</dt>
					<dd>
						{opened.profile === 'wifi'
							? 'Wi-Fi'
							: tr('Mobile data', 'モバイル通信')}{opened.network === 'unknown'
							? tr(' (connection unknown)', '（接続種別不明）')
							: ''}
					</dd>{/if}
				{#if opened.requestedFormat}<dt>{tr('Requested quality', '要求した音質')}</dt>
					<dd>
						{opened.requestedFormat === 'original'
							? tr('Original', 'オリジナル')
							: opened.requestedFormat.toUpperCase()}{opened.requestedRate
							? ' · ' + opened.requestedRate + ' kbps'
							: ''}
					</dd>{/if}
				{#if opened.response}<dt>{tr('DN response', 'DN の応答')}</dt>
					<dd>
						{opened.response === 'converted'
							? tr('Live conversion', 'リアルタイム変換')
							: opened.response === 'fallback'
								? tr('Original after conversion declined', '変換不可のためオリジナル')
								: tr('Original file', '元ファイル')}
					</dd>{/if}
			</dl>
		{/if}
	</section>
	{#if !output.remote}
		<section>
			<h3>{tr('Audio processing', 'オーディオ処理')}</h3>
			<dl>
				{#if output.speed}<dt>{tr('Playback speed', '再生速度')}</dt>
					<dd>{output.speed}×</dd>{/if}
				{#if Capacitor.isNativePlatform()}
					<dt>{tr('Equalizer', 'イコライザー')}</dt>
					<dd>
						{output.equalizer === undefined
							? unknown
							: output.equalizer
								? tr('On', 'オン')
								: tr('Off', 'オフ')}
					</dd>
					<dt>{tr('ReplayGain setting', 'ReplayGain 設定')}</dt>
					<dd>
						{output.replayGain === 'album'
							? tr('Album', 'アルバム')
							: output.replayGain === 'track'
								? tr('Track', 'トラック')
								: output.replayGain === 'off'
									? tr('Off', 'オフ')
									: unknown}
					</dd>
				{/if}
			</dl>
			{#if !output.speed && !Capacitor.isNativePlatform()}<p>{unknown}</p>{/if}
		</section>
	{/if}
	<section>
		<h3>
			{output.remote ? tr('Cast receiver', 'キャスト先') : tr('Output device', '出力デバイス')}
		</h3>
		<p>{device}</p>
		{#if output.outputRate}<dl>
				<dt>{tr('App output sample rate', 'アプリ出力のサンプルレート')}</dt>
				<dd>{sampleRate(output.outputRate)}</dd>
			</dl>{/if}
	</section>
</div>

<style>
	.path {
		display: grid;
		gap: 0.85rem;
	}
	section {
		padding-block: 0.25rem 0.8rem;
		border-bottom: 1px solid var(--line);
	}
	section:last-child {
		border-bottom: 0;
	}
	h3 {
		color: var(--accent);
		margin: 0 0 0.45rem;
		font-size: 0.95rem;
	}
	p {
		margin: 0.15rem 0;
	}
	dl {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.35rem 0.8rem;
		margin: 0;
	}
	dt {
		color: var(--muted);
	}
	dd {
		text-align: end;
		margin: 0;
	}
</style>
