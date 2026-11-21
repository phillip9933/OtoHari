<script lang="ts">
	import { uiText } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { onMount } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import { nativeEqualizer } from '../player';
	import {
		bandLabel,
		EQ_PRESET_NAMES,
		presetLevels,
		type EqPresetName,
		type EqualizerResult,
		type EqualizerState
	} from './equalizer';

	let settings = $state<EqualizerResult | null>(null),
		error = $state(''),
		busy = $state(false);
	let preview = $state<{ index: number; level: number } | null>(null);
	let sequence = 0;
	const native = Capacitor.isNativePlatform();
	async function refresh() {
		if (!native || busy || preview || document.hidden) return;
		const ticket = ++sequence;
		try {
			const result = await nativeEqualizer.getEqualizer();
			if (ticket === sequence) settings = result;
		} catch {
			if (ticket === sequence)
				settings = { available: false, reason: 'Could not connect to the playback equalizer.' };
		}
	}
	onMount(() => {
		void refresh();
		const timer = native ? setInterval(refresh, 5000) : undefined;
		document.addEventListener('visibilitychange', refresh);
		return () => {
			sequence++;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', refresh);
		};
	});
	async function apply(change: (current: EqualizerState) => Promise<EqualizerResult>) {
		if (!settings?.available || busy) return;
		const ticket = ++sequence;
		busy = true;
		error = '';
		preview = null;
		try {
			const result = await change(settings);
			if (ticket === sequence) settings = result;
		} catch {
			if (ticket === sequence) error = 'Could not apply that setting to the current audio output.';
		} finally {
			if (ticket === sequence) busy = false;
		}
		if (error) void refresh();
	}
	function save(changes: Partial<Pick<EqualizerState, 'enabled' | 'levels' | 'preset'>>) {
		return apply((current) =>
			nativeEqualizer.setEqualizer({
				enabled: current.enabled,
				centers: current.centers,
				levels: current.levels,
				preset: current.preset,
				outputId: current.output?.id,
				...changes
			})
		);
	}
	function assign(id: string, assigned: boolean) {
		void apply(() => nativeEqualizer.setEqualizerOutput({ outputId: id, assigned }));
	}
	function preset(name: EqPresetName) {
		if (settings?.available) void save({ preset: name, levels: presetLevels(settings, name) });
	}
	function band(index: number, value: number) {
		if (!settings?.available) return;
		const levels = [...settings.levels];
		levels[index] = Math.round(value * 100);
		void save({ levels, preset: '' });
	}
	const gain = (level: number) => (level > 0 ? '+' : '') + Number((level / 100).toFixed(2)) + ' dB';
</script>

{#if !native}<p>{uiText('The playback equalizer is available on supported mobile devices.')}</p>
{:else if !settings}<p role="status">{uiText('Checking audio output…')}</p>
{:else if !settings.available}<p role="status">{settings.reason}</p>
	<button class="secondary" onclick={refresh}>{uiText('Check again')}</button>
{:else}
	<section
		class="eq settings-stack"
		data-part="equalizer"
		aria-label={uiText('Playback equalizer')}
	>
		<div class="settings-panel" data-surface="panel">
			{#if settings.output}
				{@const output = settings.output}
				<label class="toggle"
					><input
						type="checkbox"
						checked={output.assigned}
						disabled={busy}
						onchange={(e) => assign(output.id, e.currentTarget.checked)}
					/>{uiText('Remember a separate preset for')}
					{output.name}</label
				>
			{/if}
			<label class="toggle"
				><input
					type="checkbox"
					aria-label={uiText('Enable equalizer')}
					checked={settings.enabled}
					disabled={busy}
					onchange={(e) => save({ enabled: e.currentTarget.checked })}
				/>
				{uiText('Enable equalizer')}</label
			>
			<label
				>{uiText('Preset')}<InlineChoice
					selected={settings.preset}
					label={uiText('Equalizer preset')}
					><select
						value={settings.preset}
						disabled={!settings.enabled || busy}
						onchange={(e) => preset(e.currentTarget.value as EqPresetName)}
					>
						{#if !settings.preset}<option value="" disabled>{uiText('Custom')}</option>{/if}
						{#each EQ_PRESET_NAMES as name (name)}<option value={name}>{name}</option>{/each}
					</select></InlineChoice
				></label
			>
		</div>
		<h2 id="equalizer-bands">{uiText('Frequency bands')}</h2>
		<div class="settings-panel" data-surface="panel" role="group" aria-labelledby="equalizer-bands">
			{#each settings.centers as center, i (center)}
				{@const level = preview?.index === i ? preview.level : settings.levels[i]}
				<label class="band"
					><span>{bandLabel(center)}</span><span>{gain(level)}</span>
					<input
						type="range"
						aria-label={bandLabel(center)}
						aria-valuetext={gain(level)}
						min={settings.minimum / 100}
						max={settings.maximum / 100}
						step="0.01"
						value={level / 100}
						disabled={!settings.enabled || busy}
						oninput={(e) =>
							(preview = { index: i, level: Math.round(Number(e.currentTarget.value) * 100) })}
						onpointercancel={() => (preview = null)}
						onchange={(e) => band(i, Number(e.currentTarget.value))}
					/>
				</label>
			{/each}
		</div>
		<button class="secondary" disabled={!settings.enabled || busy} onclick={() => preset('Flat')}
			>{uiText('Reset to flat')}</button
		>
		{#if error}<p role="alert">{error}</p>{/if}
	</section>
{/if}

<style>
	.eq label {
		display: grid;
		gap: 0.25rem;
	}
	.eq .toggle {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 44px;
	}
	.band {
		grid-template-columns: 1fr auto;
	}
	.band input {
		grid-column: 1 / -1;
		min-height: 44px;
		width: 100%;
		padding: 0;
	}
	.band span:nth-child(2) {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.eq .secondary {
		justify-self: start;
	}
</style>
