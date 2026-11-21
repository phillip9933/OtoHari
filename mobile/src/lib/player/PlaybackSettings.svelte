<script lang="ts">
	import { uiText } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { onMount } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import type { Session } from '../connection';
	import { errorMessage } from '../catalog/catalog';
	import {
		conversionState,
		browserConnection,
		streamNetwork,
		original,
		rates,
		saveProfiles,
		streamProfiles,
		type Format,
		type Network,
		type Profile,
		type Profiles
	} from './streaming';
	let { session }: { session: Session } = $props();
	const connections = [
		{ id: 'wifi', name: 'Wi-Fi' },
		{ id: 'cellular', name: 'Cellular data' }
	] as const;
	let profiles = $state<Profiles>({ wifi: { ...original }, cellular: { ...original } }),
		network = $state<Network>('unknown'),
		profileError = $state(''),
		savingProfile = $state(false),
		conversion = $state<'on' | 'off' | 'unavailable' | null>(null);
	let serviceError = $state('');
	let checks = 0;
	async function readConversion() {
		const check = ++checks;
		serviceError = '';
		try {
			const state = await conversionState(session);
			if (check === checks) conversion = state.conversion;
		} catch (e) {
			if (check === checks) serviceError = errorMessage(e);
		}
	}
	async function configure(profile: Profile, format: Format, rate: number) {
		if (savingProfile) return;
		const next = { ...profiles, [profile]: { format, rate } };
		savingProfile = true;
		profileError = '';
		try {
			await saveProfiles(session, next);
			profiles = next;
		} catch (e) {
			profileError = errorMessage(e);
		} finally {
			savingProfile = false;
		}
	}
	onMount(() => {
		profiles = streamProfiles(session);
		void readConversion();
		let generation = 0;
		async function detect() {
			if (document.hidden) return;
			const id = ++generation;
			const value = await streamNetwork().catch(() => 'unknown' as const);
			if (id === generation) network = value;
		}
		const controller = new AbortController();
		const options = { signal: controller.signal };
		const connection = browserConnection();
		connection?.addEventListener('change', detect, options);
		window.addEventListener('online', detect, options);
		window.addEventListener('offline', detect, options);
		document.addEventListener('visibilitychange', detect, options);
		void detect();
		// Some native WebViews don't emit a browser connection-change event.
		const timer = setInterval(detect, 5000);
		return () => {
			checks++;
			generation++;
			clearInterval(timer);
			controller.abort();
		};
	});
</script>

<section class="settings-stack" aria-label={uiText('Mobile stream quality')}>
	<p class="connection" role="status">
		{#if network === 'wifi'}{uiText('Connected through Wi-Fi or Ethernet.')}
		{:else if network === 'cellular'}{uiText('Connected through cellular data.')}
		{:else if network === 'offline'}{uiText('Device is offline.')}
		{:else}{uiText('Connection type unknown. Streaming uses the cellular profile.')}{/if}
	</p>
	{#each connections as entry (entry.id)}
		{@const q = profiles[entry.id]}
		<h2 id={'stream-' + entry.id}>{uiText(entry.name)}</h2>
		<fieldset
			class="settings-panel"
			data-surface="panel"
			aria-labelledby={'stream-' + entry.id}
			disabled={savingProfile}
		>
			<label
				>{uiText('Audio format')}<InlineChoice
					selected={q.format}
					label={entry.name + ' audio format'}
					><select
						value={q.format}
						onchange={(e) => configure(entry.id, e.currentTarget.value as Format, q.rate)}
					>
						<option value="original">{uiText('Original file')}</option><option value="mp3"
							>MP3</option
						><option value="opus">Opus</option>
					</select></InlineChoice
				></label
			>
			{#if q.format !== 'original'}<label
					>{uiText('Requested bitrate')}<InlineChoice
						selected={q.rate}
						label={entry.name + ' requested bitrate'}
						><select
							value={q.rate}
							onchange={(e) => configure(entry.id, q.format, Number(e.currentTarget.value))}
						>
							{#each rates as rate (rate)}<option value={rate}>{rate} kbps</option>{/each}
						</select></InlineChoice
					></label
				>{/if}
		</fieldset>
	{/each}
	{#if Capacitor.getPlatform() === 'ios' && (profiles.wifi.format === 'opus' || profiles.cellular.format === 'opus')}<p
		>
			{uiText('If this device cannot play Ogg Opus, DN sends MP3 at your selected bitrate.')}
		</p>{/if}
	{#if profileError}<p role="alert">{profileError}</p>{/if}
	<p>
		{uiText(
			'Each track uses the connection available when it starts loading. If DN falls back to an original file, it plays at its source bitrate.'
		)}
	</p>
	{#if serviceError}<p role="status">{uiText('Could not check DN conversion.')} {serviceError}</p>
		<button class="secondary" onclick={readConversion}>{uiText('Check conversion again')}</button>
	{:else if conversion === 'off'}<p>
			{uiText(
				'Conversion is turned off. Your format choices take effect when On-the-fly transcoding is enabled in DN’s Settings → Connect Apps.'
			)}
		</p>
		<button class="text-button" onclick={readConversion}>{uiText('Check conversion again')}</button>
	{:else if conversion === 'unavailable'}<p>
			{uiText('DN reports that ffmpeg is unavailable. Original files can still play.')}
		</p>
		<button class="text-button" onclick={readConversion}>{uiText('Check conversion again')}</button>
	{:else if conversion === 'on'}<p>{uiText('DN can convert streams for both profiles.')}</p>
	{:else}<p role="status">{uiText('Checking server conversion…')}</p>{/if}
</section>

<style>
	label {
		display: grid;
		gap: 0.35rem;
	}
	.connection {
		color: var(--text);
	}
	button {
		justify-self: start;
	}
</style>
