<script lang="ts">
	import { uiText } from '../i18n';
	import { onMount } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import EqualizerSettings from './EqualizerSettings.svelte';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { playbackSpeeds, soundSettings, type ReplayGainMode } from './sound';
	let { speedOnly = false }: { speedOnly?: boolean } = $props();
	let value = $state<Awaited<ReturnType<typeof soundSettings>>>(),
		busy = $state(false),
		error = $state('');
	async function update(change?: Parameters<typeof soundSettings>[0]) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			value = await soundSettings(change);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read audio settings.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		void update();
	});
</script>

<div
	id={speedOnly ? undefined : 'playback-speed'}
	class:settings-panel={!speedOnly}
	data-surface={speedOnly ? undefined : 'panel'}
	class="sound"
>
	{#if value}
		<label
			>{uiText('Playback speed')}<InlineChoice
				selected={value.speed}
				label={uiText('Playback speed')}
			>
				<select
					value={value.speed}
					disabled={busy}
					onchange={(e) => void update({ speed: Number(e.currentTarget.value) })}
				>
					{#each playbackSpeeds as rate (rate)}<option value={rate}>{rate}×</option>{/each}
				</select>
			</InlineChoice></label
		>
		{#if !speedOnly && Capacitor.isNativePlatform()}
			<label id="volume-normalization"
				>{uiText('Volume normalization')}<InlineChoice
					selected={value.replayGain}
					label={uiText('Volume normalization')}
				>
					<select
						value={value.replayGain}
						disabled={busy}
						onchange={(e) => void update({ replayGain: e.currentTarget.value as ReplayGainMode })}
					>
						<option value="off">{uiText('Off')}</option><option value="track"
							>{uiText('Track ReplayGain')}</option
						><option value="album">{uiText('Album ReplayGain')}</option>
					</select>
				</InlineChoice></label
			>
			<p>
				{uiText(
					'Track gain evens out individual songs. Album gain preserves their relative volume. OtoHari uses loudness values from DN when available and falls back to ReplayGain tags.'
				)}
			</p>
		{/if}
	{:else if !error}<p role="status">{uiText('Reading audio settings…')}</p>{/if}
	{#if error}<p role="alert">{error}</p>
		<button class="secondary" disabled={busy} onclick={() => void update()}
			>{uiText('Check again')}</button
		>{/if}
</div>

{#if !speedOnly && Capacitor.isNativePlatform()}
	<h2 id="sound-equalizer">{uiText('Equalizer')}</h2>
	<EqualizerSettings />
{/if}

<style>
	.sound,
	label {
		display: grid;
		gap: 0.45rem;
	}
	.sound {
		gap: 0.85rem;
	}
</style>
