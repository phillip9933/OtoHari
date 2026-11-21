<script lang="ts">
	import { onMount } from 'svelte';
	import { uiText, tr } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { errorMessage } from '../catalog/catalog';
	import {
		readTrackFade,
		setTrackFade,
		fadeLengths,
		defaultFades,
		type TrackFades
	} from './streaming';
	const fadeEdges = [
		{ key: 'fadeInMs', label: 'Fade in' },
		{ key: 'fadeOutMs', label: 'Fade out' }
	] as const;
	let fadeError = $state(''),
		fades = $state<TrackFades>({ ...defaultFades }),
		loadingFades = $state(true),
		saving = $state(false);
	async function fade(change: Partial<TrackFades>) {
		if (saving) return;
		saving = true;
		fadeError = '';
		try {
			const next = { ...fades, ...change };
			await setTrackFade(next);
			fades = next;
		} catch (e) {
			fadeError = errorMessage(e);
		} finally {
			saving = false;
		}
	}
	onMount(() => {
		void readTrackFade()
			.then((v) => (fades = v))
			.catch((e) => (fadeError = errorMessage(e)))
			.finally(() => (loadingFades = false));
	});
</script>

<section class="settings-stack" id="track-fades-settings">
	<div class="settings-panel" data-surface="panel" role="group" aria-label={uiText('Track fades')}>
		<label id="smart-fades"
			><input
				type="checkbox"
				checked={fades.smart}
				disabled={loadingFades || saving}
				aria-describedby="smart-fades-help"
				onchange={(e) => {
					const requested = e.currentTarget.checked;
					e.currentTarget.checked = fades.smart;
					void fade({ smart: requested });
				}}
			/>
			{uiText('Smart fades')}</label
		>
		<p id="smart-fades-help">
			{uiText(
				'Blend quiet endings and intros or match steady beats for up to eight seconds. Consecutive album tracks and songs with no suitable blend play straight through.'
			)}
		</p>
		<fieldset class="fade-lengths" aria-describedby={fades.smart ? 'fade-lengths-help' : undefined}>
			<legend>{fades.smart ? uiText('Fallback fades') : uiText('Manual fades')}</legend>
			{#if fades.smart}<p id="fade-lengths-help">
					{uiText(
						'These times apply at the start and end of the queue and whenever the player can’t prepare a smart transition.'
					)}
				</p>{/if}
			{#each fadeEdges as edge (edge.key)}
				<label id={edge.key === 'fadeInMs' ? 'fade-in' : 'fade-out'}>
					{uiText(edge.label)}
					<InlineChoice selected={fades[edge.key]} label={uiText(edge.label)}
						><select
							value={fades[edge.key]}
							disabled={loadingFades || saving}
							onchange={(e) => fade({ [edge.key]: Number(e.currentTarget.value) })}
						>
							{#each fadeLengths as ms (ms)}<option value={ms}
									>{ms ? tr(ms / 1000 + ' seconds', ms / 1000 + ' 秒') : uiText('Off')}</option
								>{/each}
						</select></InlineChoice
					>
				</label>
			{/each}
		</fieldset>
	</div>
	{#if fadeError}<p role="alert">{fadeError}</p>{/if}
</section>

<style>
	label {
		display: grid;
		gap: 0.35rem;
	}
	.fade-lengths {
		display: grid;
		gap: 0.75rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.fade-lengths legend {
		float: left;
		width: 100%;
		padding: 0.75rem 0 0;
		border-top: 1px solid var(--line);
		color: var(--heading);
		font-weight: 600;
	}
</style>
