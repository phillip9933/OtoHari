<script lang="ts">
	import { uiText } from '../i18n';
	import { onMount } from 'svelte';
	import { Capacitor } from '@capacitor/core';
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

<div class:settings-panel={!speedOnly} data-surface={speedOnly ? undefined : 'panel'} class="sound">
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
			<label
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
					'Track gain evens out individual songs. Album gain preserves the volume differences within an album. Both use the ReplayGain tags in your DN library.'
				)}
			</p>
		{/if}
	{:else if !error}<p role="status">{uiText('Reading audio settings…')}</p>{/if}
	{#if error}<p role="alert">{error}</p>
		<button class="secondary" disabled={busy} onclick={() => void update()}
			>{uiText('Check again')}</button
		>{/if}
</div>

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
