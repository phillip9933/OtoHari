<script lang="ts">
	import { uiText } from '../i18n';
	import { Capacitor } from '@capacitor/core';
	import { tick } from 'svelte';
	import type { Section } from '../boards/layout';
	import PlayerActionFace from './PlayerActionFace.svelte';
	import { Cast, ChevronRight, Speaker } from '@lucide/svelte';
	import ReviewSheet from '../catalog/ReviewSheet.svelte';
	import SonosControls from './SonosControls.svelte';
	import { airplay, nativeOutput as player, type OutputDevice } from './native';

	let {
		compact = false,
		settingsEntry = false,
		breadcrumb,
		section
	}: {
		compact?: boolean;
		settingsEntry?: boolean;
		breadcrumb?: string;
		section?: Section;
	} = $props();
	const android = Capacitor.getPlatform() === 'android';
	const ios = Capacitor.getPlatform() === 'ios';
	let open = $state(false),
		busy = $state(false),
		searched = $state(false);
	let destination = $state(''),
		error = $state(''),
		devices = $state<OutputDevice[]>([]);
	let revision = 0;
	let opener = $state<HTMLButtonElement>();
	function close() {
		open = false;
		++revision;
		void tick().then(() => opener?.isConnected && opener.focus({ preventScroll: true }));
	}
	async function run(action: () => Promise<void>) {
		const version = revision;
		busy = true;
		error = '';
		try {
			await action();
		} catch (e) {
			if (version === revision)
				error = e instanceof Error ? e.message : 'The output is unavailable.';
		} finally {
			if (version === revision) busy = false;
		}
	}
	function show() {
		++revision;
		open = true;
		searched = false;
		devices = [];
		const version = revision;
		void run(async () => {
			if (ios) {
				await airplay.choose();
				if (version === revision) close();
			} else {
				const state = await player.outputState();
				if (version === revision) destination = state.destination;
			}
		});
	}
	function search() {
		const version = revision;
		void run(async () => {
			const result = await player.findOutputs();
			if (version === revision) {
				devices = result.devices;
				searched = true;
			}
		});
	}
	function select(id?: string) {
		const version = revision;
		void run(async () => {
			const state = id ? await player.castTo({ id }) : await player.stopCasting();
			if (version === revision) destination = state.destination;
		});
	}
	function google() {
		const version = revision;
		void run(async () => {
			const state = await player.googleCast();
			if (version === revision) destination = state.destination;
		});
	}
</script>

{#if android || ios}
	<button
		class={settingsEntry ? 'settings-entry' : compact ? 'icon-button' : 'secondary'}
		class:player-control={compact}
		aria-label={uiText('Cast and audio output')}
		aria-haspopup="dialog"
		aria-expanded={open}
		bind:this={opener}
		onclick={show}
	>
		{#if settingsEntry}<Cast size={19} /><span
				>{uiText('Cast and audio output')}{#if breadcrumb}<small class="breadcrumb"
						>{breadcrumb}</small
					>{/if}</span
			><ChevronRight size={16} />
		{:else}<PlayerActionFace
				{section}
				glyph={Cast}
				size={compact ? 21 : 18}
				label={uiText('Cast and audio output')}
				defaultLabel={!compact}
			/>{/if}
	</button>
{/if}
{#if open}
	<ReviewSheet title={uiText('Cast and audio output')} onback={close}>
		<div class="outputs settings-stack">
			{#if android}
				<h3>{uiText('Music output')}</h3>
				<div class="settings-panel" data-surface="panel">
					<p role="status">
						{destination ? `Casting to ${destination}` : uiText('Playing on this phone')}
					</p>
					{#if destination}
						<p>{uiText('Stopping the cast pauses the queue on this phone.')}</p>
						<button class="secondary" disabled={busy} onclick={() => select()}
							>{uiText('Stop casting')}</button
						>
					{:else}
						<button class="primary" disabled={busy} onclick={google}
							><Cast size={18} />{uiText('Choose Google Cast device')}</button
						>
					{/if}
				</div>
				<h3>{uiText('Other network speakers')}</h3>
				<div class="settings-panel" data-surface="panel">
					<p>{uiText('Find speakers and TVs that support UPnP or DLNA on this Wi-Fi network.')}</p>
					{#if !destination}{#each devices as device (device.id)}
							<button class="secondary" disabled={busy} onclick={() => select(device.id)}
								><Speaker size={18} />{device.name}</button
							>
						{/each}{/if}
					{#if searched && devices.length === 0}<p role="status">
							{uiText('No compatible receivers found.')}
						</p>{/if}
					<button class="secondary" disabled={busy} onclick={search}
						>{searched ? uiText('Search again') : uiText('Find network speakers')}</button
					>
				</div>
				{#if devices.some((d) => d.sonos)}{#key devices}<SonosControls />{/key}{/if}
				{#if !destination}
					<h3>{uiText('Cast display')}</h3>
					<div class="settings-panel" data-surface="panel">
						<p>
							{uiText(
								'Android’s Cast settings can share the phone’s screen and audio with a compatible display.'
							)}
						</p>
						<button class="secondary" disabled={busy} onclick={() => run(() => player.castScreen())}
							>{uiText('Open Cast settings')}</button
						>
					</div>
				{/if}
			{:else}
				<button class="secondary" disabled={busy} onclick={show}
					>{uiText('Choose AirPlay output')}</button
				>
			{/if}
			{#if busy && android}<p role="status">{uiText('Connecting…')}</p>{/if}
			{#if error}<p role="alert">{error}</p>{/if}
		</div>
	</ReviewSheet>
{/if}

<style>
	.breadcrumb {
		display: block;
		font-weight: 400;
		color: var(--muted);
	}
	h3 {
		margin: 0.75rem 0 0;
		color: var(--heading, var(--text));
		font-size: 1.12rem;
		line-height: 1.28;
	}
	h3:first-child,
	p {
		margin: 0;
	}
	p {
		color: var(--muted);
	}
	.outputs button {
		overflow-wrap: anywhere;
	}
</style>
