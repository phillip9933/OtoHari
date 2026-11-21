<script lang="ts">
	import { uiText } from '../i18n';
	import { untrack } from 'svelte';
	import type { Session } from '../connection';
	import type { Section } from '../boards/layout';
	import type { PlayerTrack } from '../player';
	import { trackWaveform } from './waveform';

	let {
		session,
		track,
		section,
		position,
		duration,
		playing,
		sample = false,
		onpreview,
		onseek
	}: {
		session: Session;
		track: PlayerTrack;
		section?: Section;
		position: number;
		duration: number;
		playing: boolean;
		sample?: boolean;
		onpreview?: (seconds: number | null) => void;
		onseek: (seconds: number) => void;
	} = $props();
	const clip = $props.id();
	const style = $derived(section?.seekStyle ?? 'standard');
	const identity = $derived(
		JSON.stringify([session.serverUrl, session.userId, track.id, track.streamUrl])
	);
	let dragging = $state<number | null>(null),
		peaks = $state.raw<number[]>([]),
		unavailable = $state(false);
	const now = $derived(Math.min(Math.max(0, dragging ?? position), Math.max(0, duration)));
	const ratio = $derived(duration > 0 ? now / duration : 0);
	const elapsed = $derived(section?.showElapsed ?? true);
	const length = $derived(section?.showDuration ?? true);
	const remaining = $derived(section?.showRemaining ?? false);
	const stamp = (v: number) =>
		Math.floor(v / 60) + ':' + String(Math.floor(v % 60)).padStart(2, '0');
	const demo = Array.from({ length: 112 }, (_, i) =>
		Math.abs(Math.sin(i * 0.13) * Math.cos(i * 0.39) * 0.71 + Math.sin(i * 0.033) * 0.22)
	);
	const animatedPath = 'M-24 12 ' + Array.from({ length: 12 }, () => 'q5 -10 10 0 t10 0').join(' ');
	$effect(() => {
		void identity;
		dragging = null;
		peaks = [];
		unavailable = false;
		if (style !== 'waveform') return;
		if (sample) {
			peaks = demo;
			return;
		}
		const controller = new AbortController();
		untrack(() => trackWaveform(session, track, controller.signal)).then(
			(data) => {
				if (!controller.signal.aborted) {
					peaks = data;
					unavailable = !data.length;
				}
			},
			() => {
				if (!controller.signal.aborted) unavailable = true;
			}
		);
		return () => controller.abort();
	});
	function finish(value: number) {
		dragging = null;
		onpreview?.(null);
		if (!sample && duration > 0) onseek(value);
	}
</script>

<div class="progress" class:grid={!!section?.grid} data-seek-style={style} data-part="playback-bar">
	<div
		class="rail"
		class:animated={style === 'animated'}
		class:running={playing}
		class:peaks={style === 'waveform' && peaks.length > 0}
	>
		{#if style === 'waveform' && peaks.length}
			<svg viewBox="0 0 224 24" preserveAspectRatio="none" aria-hidden="true">
				<defs
					><path
						id={clip + '-bars'}
						d={peaks
							.map(
								(v, i) =>
									'M' +
									(224 * (i + 0.5)) / peaks.length +
									' ' +
									(12 - Math.max(0.8, v * 11)) +
									'v' +
									Math.max(0.8, v * 11) * 2
							)
							.join(' ')}
					/>
					<clipPath id={clip}><rect x="0" y="0" width={224 * ratio} height="24" /></clipPath></defs
				>
				<use href={'#' + clip + '-bars'} class="unplayed" /><use
					href={'#' + clip + '-bars'}
					class="played"
					clip-path={'url(#' + clip + ')'}
				/>
			</svg>
		{:else if style === 'animated'}
			<svg viewBox="0 0 200 24" preserveAspectRatio="none" aria-hidden="true">
				<defs
					><clipPath id={clip}><rect x="0" y="0" width={200 * ratio} height="24" /></clipPath></defs
				>
				<path class="unplayed" d="M0 12h200" />
				<g clip-path={'url(#' + clip + ')'}><path class="played wave" d={animatedPath} /></g>
			</svg>
		{:else}
			<span class="line"><span style:width={ratio * 100 + '%'}></span></span>
		{/if}
		<span class="thumb" style:left={ratio * 100 + '%'}></span>
		<input
			type="range"
			aria-label={uiText('Playback position')}
			min="0"
			max={duration || 0}
			step="0.1"
			value={now}
			disabled={!duration || sample}
			aria-valuetext={stamp(now) + ' of ' + stamp(duration)}
			oninput={(e) => {
				dragging = Number(e.currentTarget.value);
				onpreview?.(dragging);
			}}
			onchange={(e) => finish(Number(e.currentTarget.value))}
			onpointercancel={() => {
				dragging = null;
				onpreview?.(null);
			}}
		/>
	</div>
	{#if elapsed || length || remaining}<div class="times">
			{#if elapsed}<time aria-label={uiText('Elapsed time')}>{stamp(now)}</time>{/if}
			<span></span>
			{#if remaining}<time aria-label={uiText('Time remaining')}
					>−{stamp(Math.max(0, duration - now))}</time
				>{/if}
			{#if length}<time aria-label={uiText('Track length')}>{stamp(duration)}</time>{/if}
		</div>{/if}
	{#if style === 'waveform' && unavailable}<small class="unavailable"
			>{uiText('Waveform unavailable')}</small
		>{/if}
</div>

<style>
	.progress {
		width: 100%;
		min-width: 0;
		color: var(--accent);
	}
	.rail {
		position: relative;
		height: clamp(24px, 3.4dvh, 34px);
		display: flex;
		align-items: center;
	}
	.grid:has(.times) .rail {
		max-height: max(4px, calc(100cqh - 2 * var(--field-padding, 0px) - 0.9rem));
	}
	.rail:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		border-radius: 6px;
	}
	.rail input {
		position: absolute;
		inset: 0;
		margin: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: pointer;
		padding: 0;
	}
	.line {
		width: 100%;
		height: 4px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--text) 28%, transparent);
		overflow: hidden;
	}
	.line span {
		display: block;
		height: 100%;
		background: currentColor;
	}
	.thumb {
		position: absolute;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		transform: translateX(-50%);
		background: currentColor;
		pointer-events: none;
	}
	svg {
		width: 100%;
		height: 24px;
		overflow: hidden;
		fill: none;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.played {
		stroke: currentColor;
	}
	.unplayed {
		stroke: color-mix(in srgb, var(--text) 33%, transparent);
	}
	.running .wave {
		animation: travel 1s linear infinite;
	}
	@keyframes travel {
		to {
			transform: translateX(20px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.running .wave {
			animation: none;
		}
	}
	.times {
		display: flex;
		align-items: center;
		gap: 0.65em;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		font-size: 0.78rem;
		line-height: 1.15;
	}
	.times span {
		flex: 1;
	}
	.unavailable {
		display: block;
		color: var(--muted);
		font-size: 0.7rem;
	}
</style>
