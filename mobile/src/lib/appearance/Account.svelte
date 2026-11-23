<script lang="ts">
	import ProfilePhoto from './ProfilePhoto.svelte';
	import { uiText } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { Browser } from '@capacitor/browser';
	import { ExternalLink } from '@lucide/svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { getJson, mutateJson, postJson, putJson, type Session } from '../connection';
	import { path, errorMessage } from '../catalog/catalog';
	type S = components['schemas'];
	let { session }: { session: Session } = $props();
	let view = $state<'Profile' | 'Listening' | 'Devices' | 'Services'>('Profile'),
		profile = $state<S['ProfileResponse']>(),
		prefs = $state<S['ScrobblePreferences']>(),
		devices = $state<S['SessionView'][]>([]);
	let name = $state(''),
		visibility = $state<S['NowPlayingVisibility']>('offline'),
		lastfm = $state(false),
		listenbrainz = $state(false),
		confirm = $state('');
	const nameTooLong = $derived(Array.from(name.trim()).length > 64);
	let username = $state(''),
		email = $state(''),
		editIdentity = $state(false);
	let source = $state<S['ListenSource']>('listenbrainz'),
		auto = $state(false),
		navidrome = $state(false);
	let services = $state<S['LinkedAccount'][]>([]);
	let busy = $state(true),
		saving = $state(false),
		error = $state(''),
		message = $state(''),
		retry = $state(0);
	const views = ['Profile', 'Listening', 'Devices', 'Services'] as const;
	$effect(() => {
		const current = view,
			account = session;
		void retry;
		let active = true;
		busy = true;
		error = message = confirm = '';
		editIdentity = false;
		async function read() {
			try {
				if (current === 'Profile') {
					const p = await getJson<S['ProfileResponse']>(account, path('/api/v3/me'));
					if (active) {
						profile = p;
						name = p.display_name;
						username = p.username_display ?? p.username ?? '';
						email = p.email ?? '';
					}
				} else if (current === 'Listening') {
					const p = await getJson<S['ScrobblePreferences']>(
						account,
						path('/api/v3/me/scrobble-preferences')
					);
					if (active) {
						prefs = p;
						source = p.primary_music_source ?? 'listenbrainz';
						auto = !!p.auto_request_personal_mix;
						navidrome = !!p.navidrome_handles_external_scrobbles;
						visibility = p.now_playing_visibility ?? 'offline';
						lastfm = !!p.scrobble_to_lastfm;
						listenbrainz = !!p.scrobble_to_listenbrainz;
					}
				} else if (current === 'Services') {
					const result = await getJson<S['LinkedAccounts']>(
						account,
						path('/api/v3/me/connections')
					);
					if (active) services = result.connections;
				} else {
					const p = await getJson<S['SessionListResponse']>(account, path('/api/v3/auth/sessions'));
					if (active) devices = p.sessions;
				}
			} catch (e) {
				if (active) error = errorMessage(e);
			} finally {
				if (active) busy = false;
			}
		}
		void read();
		return () => {
			active = false;
		};
	});
	async function save() {
		if (saving || (view === 'Profile' && (nameTooLong || !name.trim()))) return;
		saving = true;
		error = message = '';
		try {
			if (view === 'Profile') {
				const p = await mutateJson<S['UserResponse']>(session, path('/api/v3/me'), 'PATCH', {
					display_name: name.trim()
				});
				profile = p;
				name = p.display_name;
				message = 'Display name saved.';
			} else if (view === 'Listening' && prefs) {
				const body: Partial<S['ScrobblePreferencesUpdate']> = {};
				if (source !== (prefs.primary_music_source ?? 'listenbrainz'))
					body.primary_music_source = source;
				if (auto !== !!prefs.auto_request_personal_mix) body.auto_request_personal_mix = auto;
				if (navidrome !== !!prefs.navidrome_handles_external_scrobbles)
					body.navidrome_handles_external_scrobbles = navidrome;
				if (visibility !== prefs.now_playing_visibility) body.now_playing_visibility = visibility;
				if (lastfm !== !!prefs.scrobble_to_lastfm) body.scrobble_to_lastfm = lastfm;
				if (listenbrainz !== !!prefs.scrobble_to_listenbrainz)
					body.scrobble_to_listenbrainz = listenbrainz;
				prefs = await putJson<S['ScrobblePreferences']>(
					session,
					path('/api/v3/me/scrobble-preferences'),
					body
				);
				message = 'Listening preferences saved.';
			} else if (view === 'Devices' && confirm) {
				await mutateJson<void>(
					session,
					path('/api/v3/auth/sessions/{id}', { id: confirm }),
					'DELETE'
				);
				devices = devices.filter((d) => d.id !== confirm);
				confirm = '';
				message = 'Device signed out.';
			}
		} catch (e) {
			error = errorMessage(e);
		} finally {
			saving = false;
		}
	}
	async function identity(field: 'username' | 'email') {
		if (saving) return;
		saving = true;
		error = message = '';
		try {
			profile =
				field === 'username'
					? await putJson<S['UserResponse']>(session, path('/api/v3/me/username'), {
							username: username.trim()
						} satisfies S['UsernameUpdate'])
					: await putJson<S['UserResponse']>(session, path('/api/v3/me/email'), {
							email: email.trim() || null
						} satisfies S['EmailUpdate']);
			if (field === 'username') username = profile.username_display ?? profile.username ?? '';
			else email = profile.email ?? '';
			message = field === 'username' ? 'Username saved.' : 'Email saved.';
		} catch (e) {
			error = errorMessage(e);
		} finally {
			saving = false;
		}
	}
	async function refreshMix() {
		if (saving) return;
		saving = true;
		error = message = '';
		try {
			const result = await postJson<S['RequestsRefreshResponse']>(
				session,
				path('/api/v3/requests/personal-mix/refresh')
			);
			message =
				result.status === 'already_running'
					? 'A mix refresh is already running.'
					: 'Refreshing your personal mix in the background.';
		} catch (e) {
			error = errorMessage(e);
		} finally {
			saving = false;
		}
	}
	async function web(route: string) {
		try {
			await Browser.open({ url: session.serverUrl + route });
		} catch (e) {
			error = errorMessage(e);
		}
	}
</script>

<div
	class="settings-tabs account-tabs"
	data-surface="panel"
	role="group"
	aria-label={uiText('Account views')}
>
	{#each views as v (v)}<button
			aria-pressed={v === view}
			disabled={saving}
			onclick={() => (view = v)}>{uiText(v)}</button
		>{/each}
</div>
{#if busy}<p role="status">{uiText('Loading…')}</p>
{:else if view === 'Profile' && profile}
	{#key session}<ProfilePhoto
			{session}
			{profile}
			onupdate={(avatar_url) => {
				if (profile) profile = { ...profile, avatar_url };
			}}
		/>{/key}
	<form
		class="settings-panel"
		data-surface="panel"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<label
			>{uiText('Display name')}<input
				required
				bind:value={name}
				aria-invalid={nameTooLong}
			/></label
		><button
			class="secondary"
			disabled={saving || nameTooLong || !name.trim() || name.trim() === profile.display_name}
			>{uiText('Save name')}</button
		>
		{#if nameTooLong}<p role="alert">
				{uiText('Use up to 64 characters for your display name.')}
			</p>{/if}
	</form>
	<details class="settings-disclosure" data-surface="panel" bind:open={editIdentity}>
		<summary>{uiText('Username and email')}</summary>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				void identity('username');
			}}
		>
			<label
				>{uiText('Username')}<input required autocomplete="username" bind:value={username} /></label
			><button
				class="secondary"
				disabled={saving ||
					!username.trim() ||
					username.trim() === (profile.username_display ?? profile.username ?? '')}
				>{uiText('Save username')}</button
			>
		</form>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				void identity('email');
			}}
		>
			<label>{uiText('Email')}<input type="email" autocomplete="email" bind:value={email} /></label
			><button class="secondary" disabled={saving || email.trim() === (profile.email ?? '')}
				>{uiText('Save email')}</button
			>
		</form>
	</details>
	<h2>{uiText('Open in web app')}</h2>
	<div class="settings-list" data-surface="panel">
		<button class="settings-entry" onclick={() => web('/profile#connected-services')}
			><span>{uiText('Connected services')}</span><ExternalLink size={15} /></button
		>
		<button class="settings-entry" onclick={() => web('/profile#account')}
			><span>{uiText('Account and security')}</span><ExternalLink size={15} /></button
		>
		{#if profile.role === 'admin'}
			<button class="settings-entry" onclick={() => web('/settings')}
				><span>{uiText('Server settings')}</span><ExternalLink size={15} /></button
			>
			<button class="settings-entry" onclick={() => web('/library/management')}
				><span>{uiText('Library management')}</span><ExternalLink size={15} /></button
			>
		{/if}
	</div>
{:else if view === 'Listening' && prefs}
	<form
		class="settings-panel"
		data-surface="panel"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<label
			>{uiText('Now playing visibility')}<InlineChoice selected={visibility}
				><select bind:value={visibility}
					><option value="full">{uiText('Show track and artist')}</option><option
						value="track_hidden">{uiText('Show that I’m listening')}</option
					><option value="offline">{uiText('Show me as offline')}</option></select
				></InlineChoice
			></label
		>
		<label class="check"
			><input type="checkbox" bind:checked={lastfm} />{uiText('Scrobble to Last.fm')}</label
		>
		<label class="check"
			><input type="checkbox" bind:checked={listenbrainz} />{uiText(
				'Scrobble to ListenBrainz'
			)}</label
		>
		<label
			>{uiText('Discovery listening source')}<InlineChoice selected={source}
				><select bind:value={source}
					><option value="listenbrainz">ListenBrainz</option><option value="lastfm">Last.fm</option
					></select
				></InlineChoice
			></label
		>
		<label class="check"
			><input type="checkbox" bind:checked={auto} />{uiText(
				'Automatically request my personal mix'
			)}</label
		>
		{#if prefs.auto_request_state && prefs.auto_request_state !== 'none'}<small
				>{uiText('Approval:')} {prefs.auto_request_state}</small
			>{/if}
		{#if prefs.navidrome_handles_external_scrobbles !== undefined}<label class="check"
				><input type="checkbox" bind:checked={navidrome} />{uiText(
					'Let Navidrome forward its own scrobbles'
				)}</label
			>{/if}
		<button class="secondary" disabled={saving}>{uiText('Save preferences')}</button>
	</form>
	<button class="text-button" disabled={saving} onclick={refreshMix}
		>{uiText('Refresh personal mix')}</button
	>
{:else if view === 'Services'}
	<h2>{uiText('Connected services')}</h2>
	{#if services.length}<div class="settings-list" data-surface="panel">
			{#each services as service (service.service)}<div class="device">
					<strong>{service.service}</strong><small
						>{service.username || uiText('No account linked')} · {service.enabled
							? uiText('Enabled')
							: uiText('Disabled')}</small
					>
				</div>{/each}
		</div>{/if}
	{#if !services.length && !error}<p>{uiText('No connected services.')}</p>{/if}
	<button class="text-button" onclick={() => web('/profile#connected-services')}
		>{uiText('Manage linked accounts in browser')}</button
	>
{:else if view === 'Devices'}
	{#if devices.length}<div class="settings-list" data-surface="panel">
			{#each devices as d (d.id)}<div class="device">
					<strong>{d.label || uiText('Device')}</strong><small
						>{d.current
							? uiText('This session')
							: 'Last active ' + new Date(d.last_seen_at * 1000).toLocaleDateString()}</small
					>
					{#if !d.current}{#if d.id === confirm}<p>
								{uiText('Sign this device out of DroppedNeedle?')}
							</p>
							<button class="secondary" disabled={saving} onclick={save}
								>{uiText('Confirm sign out')}</button
							>
							<button class="text-button" disabled={saving} onclick={() => (confirm = '')}
								>{uiText('Keep device')}</button
							>
						{:else}<button
								class="text-button"
								disabled={saving}
								aria-label={'Sign out ' + (d.label || 'device')}
								onclick={() => (confirm = d.id)}>{uiText('Sign out device')}</button
							>{/if}{/if}
				</div>{/each}
		</div>{:else if !error}<p>{uiText('No active devices.')}</p>{/if}
{/if}
{#if error}<p role="alert">{error}</p>
	<button class="text-button" disabled={saving} onclick={() => retry++}
		>{uiText('Reload account')}</button
	>{/if}
{#if message}<p role="status">{message}</p>{/if}

<style>
	.account-tabs {
		grid-template-columns: repeat(2, 1fr);
	}
	@media (min-width: 24rem) {
		.account-tabs {
			grid-template-columns: repeat(4, minmax(max-content, 1fr));
		}
	}

	form {
		display: grid;
		gap: 0.75rem;
	}
	form > button {
		justify-self: start;
	}
	label {
		display: grid;
		gap: 0.25rem;
	}
	input,
	select {
		min-width: 0;
	}
	.check {
		display: flex;
		align-items: center;
		min-height: 44px;
		gap: 0.5rem;
	}
	.check input {
		accent-color: var(--accent);
	}
	.device {
		padding: 0.65rem var(--gap);
	}
	.device strong,
	.device small {
		display: block;
		overflow-wrap: anywhere;
	}
	.device small {
		color: var(--muted);
	}
	details form + form {
		margin-top: 0.75rem;
	}
</style>
