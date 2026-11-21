<script lang="ts">
	import { uiText, tr } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import type { Section } from '../boards/layout';
	import { gridIconSize } from './grid';
	import { defaultFieldLabel, supportsPlayerLines, isPlayerMetadata } from './layout';
	let { field, change }: { field: Section; change: (patch: Partial<Section>) => void } = $props();
	const horizontal = $derived(field.align ?? (isPlayerMetadata(field.id) ? 'start' : 'center'));
	const labelShown = $derived(field.showLabel ?? defaultFieldLabel(field));
	const hasIcon = $derived(
		!supportsPlayerLines(field.id) &&
			![
				'player-artwork',
				'player-seek',
				'player-timeline',
				'player-quality',
				'player-elapsed',
				'player-duration',
				'player-remaining'
			].includes(field.id)
	);
	function number(input: HTMLInputElement, min: number, max: number) {
		return Number.isFinite(input.valueAsNumber)
			? Math.max(min, Math.min(max, input.valueAsNumber))
			: undefined;
	}
</script>

<div class="styles">
	<label
		>{uiText('Horizontal alignment')}<InlineChoice selected={horizontal}
			><select
				value={horizontal}
				onchange={(e) =>
					change({ align: (e.currentTarget.value || undefined) as Section['align'] })}
			>
				<option value="start">{uiText('Start')}</option><option value="center"
					>{uiText('Center')}</option
				><option value="end">{uiText('End')}</option></select
			></InlineChoice
		></label
	>

	<label
		>{uiText('Padding (px)')}<input
			aria-label={uiText('Padding')}
			type="number"
			inputmode="decimal"
			step="any"
			min="0"
			max="32"
			value={field.padding ?? 0}
			onchange={(e) => change({ padding: number(e.currentTarget, 0, 32) })}
		/></label
	>
	<label
		>{uiText('Vertical alignment')}<InlineChoice selected={field.vAlign ?? 'center'}
			><select
				value={field.vAlign ?? 'center'}
				onchange={(e) =>
					change({ vAlign: (e.currentTarget.value || undefined) as Section['vAlign'] })}
			>
				<option value="start">{uiText('Top')}</option><option value="center"
					>{uiText('Center')}</option
				><option value="end">{uiText('Bottom')}</option></select
			></InlineChoice
		></label
	>

	{#if hasIcon}
		<label
			>{tr('Icon sizing', 'アイコンのサイズ指定')}<InlineChoice
				selected={field.iconMode ?? 'fixed'}
			>
				<select
					value={field.iconMode ?? 'fixed'}
					onchange={(e) => change({ iconMode: e.currentTarget.value as Section['iconMode'] })}
				>
					<option value="fixed">{tr('Fixed size', '固定サイズ')}</option>
					<option value="fill">{tr('Fill tile', 'タイルに合わせる')}</option>
				</select></InlineChoice
			></label
		>
		{#if field.iconMode !== 'fill'}
			<label
				>{uiText('Icon size (px)')}<input
					type="number"
					min="12"
					max="64"
					value={field.iconSize ?? gridIconSize(field.id)}
					onchange={(e) => change({ iconSize: number(e.currentTarget, 12, 64) })}
				/></label
			>
		{/if}
	{/if}
	<label
		>{uiText('Label')}<InlineChoice
			selected={labelShown ? 'show' : 'hidden'}
			label={uiText('Label')}
			><select
				value={labelShown ? 'show' : 'hidden'}
				onchange={(e) => change({ showLabel: e.currentTarget.value === 'show' })}
				><option value="hidden">{uiText('Hidden')}</option><option value="show"
					>{uiText('Show')}</option
				></select
			></InlineChoice
		></label
	>
	{#if labelShown}
		<label
			>{uiText('Label name')}<input
				maxlength="64"
				value={field.labelName ?? ''}
				placeholder={uiText('Field name')}
				oninput={(e) => change({ labelName: e.currentTarget.value })}
			/></label
		>
		<label
			>{uiText('Label position')}<InlineChoice selected={field.labelPosition ?? 'below'}
				><select
					value={field.labelPosition ?? 'below'}
					onchange={(e) =>
						change({ labelPosition: e.currentTarget.value as Section['labelPosition'] })}
					><option value="above">{uiText('Above')}</option><option value="below"
						>{uiText('Below')}</option
					></select
				></InlineChoice
			></label
		>
	{/if}
	{#if field.id === 'player-seek' || field.id === 'player-timeline'}
		<label
			>{uiText('Seek bar style')}<InlineChoice selected={field.seekStyle ?? 'standard'}
				><select
					value={field.seekStyle ?? 'standard'}
					onchange={(e) => change({ seekStyle: e.currentTarget.value as Section['seekStyle'] })}
					><option value="standard">{uiText('Standard')}</option><option value="animated"
						>{uiText('Animated')}</option
					><option value="waveform">{uiText('Waveform')}</option></select
				></InlineChoice
			></label
		>
		{#each [['showElapsed', 'Elapsed time'], ['showDuration', 'Total time'], ['showRemaining', 'Remaining time']] as [key, label] (key)}
			{@const property = key as 'showElapsed' | 'showDuration' | 'showRemaining'}<label
				class="check"
				><input
					type="checkbox"
					checked={field[property] ?? property !== 'showRemaining'}
					onchange={(e) => change({ [property]: e.currentTarget.checked })}
				/>{uiText(label)}</label
			>{/each}
	{/if}
	{#if field.id === 'player-lyrics'}<label
			>{uiText('Lyrics display')}<InlineChoice selected={field.lyricsMode ?? 'artwork'}
				><select
					value={field.lyricsMode ?? 'artwork'}
					onchange={(e) => change({ lyricsMode: e.currentTarget.value as Section['lyricsMode'] })}
					><option value="artwork">{uiText('Over artwork')}</option><option value="sheet"
						>{uiText('Bottom sheet')}</option
					></select
				></InlineChoice
			></label
		>{/if}
	{#if supportsPlayerLines(field.id)}
		<label
			>{uiText('Text size')}<InlineChoice selected={field.textSize ?? 'normal'}
				><select
					value={field.textSize ?? 'normal'}
					onchange={(e) => change({ textSize: e.currentTarget.value as Section['textSize'] })}
				>
					<option value="small">{uiText('Small')}</option><option value="normal"
						>{uiText('Normal')}</option
					><option value="large">{uiText('Large')}</option></select
				></InlineChoice
			></label
		>

		<label
			>{uiText('Maximum lines')}<InlineChoice selected={String(field.maxLines ?? 0)}
				><select
					value={String(field.maxLines ?? 0)}
					onchange={(e) =>
						change({
							maxLines: Number(e.currentTarget.value)
						})}
				>
					<option value="0">{uiText('Unlimited')}</option
					>{#each Array.from({ length: 8 }, (_, i) => i + 1) as n (n)}<option value={String(n)}
							>{n}</option
						>{/each}</select
				></InlineChoice
			></label
		>
		<label class="check"
			><input
				type="checkbox"
				checked={!!field.reserveLines}
				disabled={!field.maxLines}
				onchange={(e) => change({ reserveLines: e.currentTarget.checked })}
			/>{uiText('Reserve all lines')}</label
		>
	{/if}
</div>

<style>
	.styles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr));
		gap: 0.45rem;
	}
	.styles label {
		min-width: 0;
		display: grid;
		gap: 0.18rem;
	}
	.styles select,
	.styles input {
		width: 100%;
		min-width: 0;
	}
	.styles .check {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		align-self: end;
		min-height: 44px;
	}
	.styles .check input {
		width: 1.15rem;
		flex: none;
	}
</style>
