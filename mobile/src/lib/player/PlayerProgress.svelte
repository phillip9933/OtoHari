<script module lang="ts">
	// The playhead is at x=0 in every frame. Taper the final wavelength down
	// to a horizontal tangent so the moving wave meets the upcoming rail.
	const waveFrames = Array.from({ length: 9 }, (_, frame) => {
		const points: string[] = [];
		for (let x = -224; x <= 0; x += 2) {
			const t = Math.min(1, Math.max(0, (-x - 2) / 18));
			const amplitude = 5 * t * t * (3 - 2 * t);
			const y = 12 + amplitude * Math.sin(2 * Math.PI * (x / 20 - frame / 8));
			points.push(`${x} ${y.toFixed(2)}`);
		}
		return 'M' + points.join(' ');
	});
	const waveCycle = waveFrames.join(';');
</script>

<script lang="ts">
	import { uiText } from '../i18n';
	import { untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
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
		bufferedRanges = [],
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
		bufferedRanges?: readonly { start: number; end: number }[];
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
	const waveform = $derived(style === 'waveform' && peaks.length > 0);
	const trackPath = $derived(
		waveform
			? peaks
					.map((v, i) => {
						const height = Math.max(0.8, v * 11);
						return `M${(224 * (i + 0.5)) / peaks.length} ${12 - height}v${2 * height}`;
					})
					.join(' ')
			: 'M0 12H224'
	);
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
	<div class="rail">
		<div class="drawing" aria-hidden="true">
			<svg viewBox="0 0 224 24" preserveAspectRatio="none">
				<defs>
					<path id={clip + '-track'} d={trackPath} class:line={!waveform && style !== 'animated'} />
					<clipPath id={clip + '-played'}><rect width={224 * ratio} height="24" /></clipPath>
					<clipPath id={clip + '-upcoming'}
						><rect x={224 * ratio} width={224 * (1 - ratio)} height="24" /></clipPath
					>
					{#if duration > 0 && bufferedRanges.length}
						<clipPath id={clip + '-buffered'}>
							{#each bufferedRanges as { start, end }, index (index)}
								{#if Number.isFinite(start) && Number.isFinite(end) && end > start}
									<rect
										x={(224 * start) / duration}
										width={(224 * (end - start)) / duration}
										height="24"
									/>
								{/if}
							{/each}
						</clipPath>
					{/if}
				</defs>
				<g clip-path={'url(#' + clip + '-upcoming)'}>
					<use href={'#' + clip + '-track'} class="unplayed" />
					{#if duration > 0 && bufferedRanges.length}
						<use
							href={'#' + clip + '-track'}
							class="buffered"
							clip-path={'url(#' + clip + '-buffered)'}
						/>
					{/if}
				</g>
				<g clip-path={'url(#' + clip + '-played)'}>
					{#if style === 'animated'}
						<path class="played wave" d={waveFrames[0]} transform={`translate(${224 * ratio} 0)`}>
							{#if playing && !prefersReducedMotion.current}
								<animate attributeName="d" values={waveCycle} dur="1s" repeatCount="indefinite" />
							{/if}
						</path>
					{:else}
						<use href={'#' + clip + '-track'} class="played" />
					{/if}
				</g>
			</svg>
			{#if style !== 'animated'}<span class="thumb" style:left={ratio * 100 + '%'}></span>{/if}
		</div>
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
		--thumb-size: 10px;
		position: relative;
		height: clamp(24px, 3.4dvh, 34px);
		display: flex;
		align-items: center;
	}
	.grid:has(.times) .rail {
		max-height: max(4px, calc(100cqh - 2 * var(--field-padding, 0px) - 0.9rem));
	}
	.rail:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
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
		appearance: none;
		border: 0;
		background: transparent;
	}
	.rail input::-webkit-slider-thumb {
		appearance: none;
		width: var(--thumb-size);
		height: var(--thumb-size);
	}
	.rail input::-moz-range-thumb {
		width: var(--thumb-size);
		height: var(--thumb-size);
		border: 0;
	}
	.drawing {
		position: absolute;
		inset: 0 calc(var(--thumb-size) / 2);
		display: grid;
		align-items: center;
		pointer-events: none;
	}
	.thumb {
		position: absolute;
		top: 50%;
		width: var(--thumb-size);
		height: var(--thumb-size);
		border-radius: 50%;
		transform: translate(-50%, -50%);
		background: currentColor;
	}
	svg {
		width: 100%;
		height: min(100%, 24px);
		overflow: hidden;
		fill: none;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.line {
		vector-effect: non-scaling-stroke;
		stroke-width: 4px;
	}
	.buffered {
		stroke: color-mix(in srgb, currentColor 55%, transparent);
	}
	.played {
		stroke: currentColor;
	}
	.unplayed {
		stroke: color-mix(in srgb, var(--text) 33%, transparent);
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
