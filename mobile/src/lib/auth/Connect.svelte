<script lang="ts">
	import { uiText } from '../i18n';
	import { onMount } from 'svelte';
	import { Browser } from '@capacitor/browser';
	import { Capacitor } from '@capacitor/core';
	import {
		loginMethods,
		pendingLogoutServers,
		serverAddress,
		useToken,
		usePassword,
		type Session,
		type LoginMethods
	} from '../connection';
	import { cancelPairing, openSignIn, watchSignIn } from './pairing';

	let { onconnected }: { onconnected: (session: Session) => void } = $props();
	let address = $state('');
	let pendingServers = $state<string[]>([]);
	let methods = $state<LoginMethods | null>(null);
	let busy = $state(false);
	let waiting = $state(false);
	let approvedServer = $state('');
	let checking = $state(false);
	let handoff: ReturnType<typeof watchSignIn>;
	let error = $state('');
	let method = $state<'password' | 'jellyfin' | 'token' | null>(null);
	let username = $state('');
	let secret = $state('');
	let browserProvider = $derived(
		[methods?.oidc && 'single sign-on (OIDC)', methods?.plex && 'Plex'].filter(Boolean).join(' or ')
	);
	let missingPairing = $derived(
		Capacitor.isNativePlatform() && browserProvider && !methods?.pairing
	);
	let submitLabel = $derived.by(() => {
		if (busy || checking) return 'Connecting…';
		if (approvedServer) return 'Retry connection';
		if (!methods) return 'Continue';
		if (method) return 'Sign in';
		if (missingPairing) return 'Open web player';
		return waiting ? 'Restart browser sign-in' : 'Continue in browser';
	});
	function failure(cause: unknown) {
		error = cause instanceof Error ? cause.message : 'Could not connect to DroppedNeedle.';
	}
	onMount(() => {
		address = localStorage.getItem('dn.lastServer') ?? '';
		handoff = watchSignIn(
			onconnected,
			(cause, retryable) => {
				checking = false;
				if (!retryable) {
					approvedServer = '';
					waiting = false;
				}
				failure(cause);
			},
			(server) => {
				address = approvedServer = server;
				checking = true;
				error = '';
			}
		);
		let active = true;
		const refreshPending = () =>
			void pendingLogoutServers()
				.then((servers) => {
					if (active) pendingServers = servers;
				})
				.catch(failure);
		window.addEventListener('dn-device-sessions', refreshPending);
		refreshPending();
		return () => {
			active = false;
			window.removeEventListener('dn-device-sessions', refreshPending);
			handoff.stop();
		};
	});
	async function submit() {
		if (busy || checking) return;
		busy = true;
		error = '';
		try {
			if (approvedServer) {
				await handoff.retry();
			} else if (!methods) {
				address = serverAddress(address);
				methods = await loginMethods(address);
				localStorage.setItem('dn.lastServer', address);
				method =
					methods.pairing || missingPairing
						? null
						: methods.local
							? 'password'
							: methods.jellyfin
								? 'jellyfin'
								: 'token';
			} else if (method) {
				await cancelPairing();
				const session =
					method === 'token'
						? await useToken(address, secret)
						: await usePassword(address, username, secret, method === 'jellyfin');
				secret = '';
				onconnected(session);
			} else if (missingPairing) {
				await Browser.open({ url: address + '/' });
			} else {
				await openSignIn(address);
				waiting = true;
			}
		} catch (cause) {
			failure(cause);
		} finally {
			busy = false;
		}
	}
	async function changeServer() {
		await cancelPairing();
		approvedServer = '';
		checking = false;
		methods = null;
		method = null;
		error = secret = username = '';
		waiting = false;
	}
	async function select(value: typeof method) {
		await cancelPairing();
		waiting = false;
		method = value;
		secret = '';
		error = '';
	}
</script>

<section class="connect" data-part="connect">
	{#each pendingServers as server (server)}
		<div role="status">
			<p>
				{uiText(
					'Signed out on this device. DroppedNeedle will retry server sign-out when connected.'
				)}
				{server}
			</p>
			<button
				class="text-button"
				onclick={() =>
					Browser.open({ url: serverAddress(server) + '/profile#sessions' }).catch(failure)}
				>{uiText('Manage server sessions')}</button
			>
		</div>
	{/each}
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<h1>{methods || approvedServer ? uiText('Sign in') : uiText('Connect your server')}</h1>
		{#if approvedServer}
			<div class="server">
				<span>{approvedServer}</span><button
					type="button"
					class="text-button"
					onclick={() => void changeServer()}>{uiText('Change server')}</button
				>
			</div>
			<p>
				{checking
					? uiText('Connecting to your server…')
					: uiText('Your browser sign-in is ready. Reconnect to your server to finish.')}
			</p>
		{:else if !methods}
			<label
				>{uiText('Server address')}<input
					required
					bind:value={address}
					placeholder="https://music.example.com"
					autocomplete="url"
					inputmode="url"
					autocapitalize="none"
					spellcheck="false"
				/></label
			>
		{:else}
			<div class="server">
				<span>{address}</span><button
					type="button"
					class="text-button"
					disabled={busy}
					onclick={() => void changeServer()}>{uiText('Change')}</button
				>
			</div>
			{#if missingPairing}
				<p>
					{uiText('To use')}
					{browserProvider}
					{uiText(
						'in this app, ask your administrator to install the DroppedNeedle web frontend with mobile pairing. You can use your usual sign-in in the web player now.'
					)}
				</p>
			{/if}
			{#if method && method !== 'token'}
				<label
					>{method === 'jellyfin'
						? uiText('Jellyfin username')
						: browserProvider
							? uiText('DroppedNeedle username')
							: uiText('Username')}<input
						required
						bind:value={username}
						autocomplete="username"
						autocapitalize="none"
					/></label
				>
				<label
					>{method === 'jellyfin'
						? uiText('Jellyfin password')
						: browserProvider
							? uiText('DroppedNeedle password')
							: uiText('Password')}<input
						required
						type="password"
						bind:value={secret}
						autocomplete="current-password"
					/></label
				>
			{:else if method === 'token'}
				<label
					>{uiText('Device session token')}<input
						required
						type="password"
						bind:value={secret}
						autocomplete="off"
						autocapitalize="none"
						spellcheck="false"
					/></label
				>
				<p>
					{uiText(
						'Use a DroppedNeedle v3 device session token. Music-app passwords work only with Subsonic and Jellyfin.'
					)}
				</p>
			{:else if !missingPairing}
				<p>
					{waiting
						? uiText('Finish signing in in your browser, then return to this app.')
						: uiText(
								'Your server will open in your browser so you can use your usual sign-in method.'
							)}
				</p>
			{/if}
		{/if}
		{#if error}<p role="alert">{error}</p>{/if}
		<button class="primary" type="submit" disabled={busy || checking}>{uiText(submitLabel)}</button>
	</form>
	{#if methods && !approvedServer}
		<div class="methods">
			{#if (methods.pairing || missingPairing) && method}<button
					class="text-button"
					onclick={() => select(null)}
					>{missingPairing
						? uiText('Back to sign-in options')
						: uiText('Use browser sign-in')}</button
				>{/if}
			{#if methods.local && method !== 'password'}<button
					class="text-button"
					onclick={() => select('password')}>{uiText('Use DroppedNeedle password')}</button
				>{/if}
			{#if methods.jellyfin && method !== 'jellyfin'}<button
					class="text-button"
					onclick={() => select('jellyfin')}>{uiText('Use Jellyfin sign-in')}</button
				>{/if}
			{#if method !== 'token'}<button class="text-button" onclick={() => select('token')}
					>{uiText('Use device session token')}</button
				>{/if}
		</div>
	{/if}
</section>

<style>
	.connect {
		margin: auto;
		width: min(100%, 32rem);
		padding: clamp(2rem, 8vh, 5rem) var(--gap, 1.2rem) 2rem;
	}
	.server {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	form {
		display: grid;
		gap: 1rem;
	}
	h1,
	p {
		margin: 0;
	}
	label {
		display: grid;
		gap: 0.35rem;
	}
	.server {
		justify-content: space-between;
		overflow-wrap: anywhere;
	}
	.methods {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1rem;
		margin-top: 0.65rem;
	}
	p,
	.server span {
		color: var(--muted);
	}
</style>
