<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import { uiText, tr, languageChoice, setLanguage, type LanguageChoice, uiFormat } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { findSettings, pageTitles, type SettingsPage as Page } from './settingsSearch';
	import InterfaceSettings from './InterfaceSettings.svelte';
	import './settings.css';
	import { shortcuts, changeScreen, type Destination } from './interface';
	import Outputs from '../player/Outputs.svelte';
	import OfflineSettings from '../offline/OfflineSettings.svelte';
	import { offlineSupported, preferredOffline } from '../offline/media';
	import PlaybackSettings from '../player/PlaybackSettings.svelte';
	import QueueSettings from '../player/QueueSettings.svelte';
	import LinkedPlayers from '../../../../frontend/src/lib/features/player/components/LinkedPlayers.svelte';
	import EqualizerSettings from '../player/EqualizerSettings.svelte';
	import UpdateSettings from '../updates/UpdateSettings.svelte';
	import { watchAndroidUpdates, type AndroidUpdateState } from '../updates/androidUpdates';
	import {
		ChevronLeft,
		ChevronRight,
		House,
		LibraryBig,
		Compass,
		Disc3,
		Palette,
		UserRound,
		SlidersHorizontal,
		Globe,
		Activity,
		Download,
		Info,
		Layers,
		ListMusic,
		Music2
	} from '@lucide/svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { getJson, type Session } from '../connection';
	import { errorMessage, path } from '../catalog/catalog';
	import BoardSettings from '../boards/BoardSettings.svelte';
	import ThemeSettings from './ThemeSettings.svelte';
	import Account from './Account.svelte';
	import LibraryScans from './LibraryScans.svelte';
	import ReleaseSettings from './ReleaseSettings.svelte';
	import WebTools from './WebTools.svelte';
	import Statistics from './Statistics.svelte';
	import ServerSections from './ServerSections.svelte';
	import pkg from '../../../package.json';
	let {
		session,
		onnavigate,
		onback,
		onplayerlayoutclose,
		onsignout,
		initial = 'menu'
	}: {
		session: Session | null;
		onnavigate: (destination: Destination) => void;
		onback: () => void;
		onplayerlayoutclose: () => void;
		onsignout: () => Promise<void>;
		initial?: Page;
	} = $props();
	let page = $state<Page>('menu'),
		root: HTMLElement,
		offset = 0,
		busy = $state(false),
		admin = $state(false),
		roleError = $state(''),
		version = $state(''),
		versionError = $state('');
	const android = Capacitor.getPlatform() === 'android';
	let updateFeed: ReturnType<typeof watchAndroidUpdates> | undefined;
	let updateState = $state.raw<AndroidUpdateState | null>(null);
	let updateError = $state('');
	const layouts = [
		{ id: 'home', label: 'Home', icon: House },
		{ id: 'library', label: 'Library', icon: LibraryBig },
		{ id: 'discover', label: 'Discover', icon: Compass },
		{ id: 'player', label: 'Now Playing', icon: Disc3 }
	] as const;
	const personal = [
		{ id: 'account', label: 'Account on DroppedNeedle', icon: UserRound },
		{ id: 'stats', label: 'Library statistics', icon: LibraryBig },
		{ id: 'content', label: 'Content preferences', icon: SlidersHorizontal },
		{ id: 'tools', label: 'Web tools', icon: Globe }
	] as const;
	const administration = [
		{ id: 'diagnostics', label: 'Server diagnostics', icon: Activity },
		{ id: 'scans', label: 'Library health and scans', icon: Activity },
		{ id: 'releases', label: 'Release types', icon: Music2 },
		{ id: 'editions', label: 'Edition preferences', icon: Layers }
	] as const;
	let searchAnchor = $state('');
	let query = $state(''),
		languageIssue = $state('');
	async function chooseLanguage(value: LanguageChoice) {
		languageIssue = '';
		try {
			await setLanguage(value);
		} catch {
			languageIssue = tr('Could not change the device language.', '言語を変更できませんでした。');
		}
	}
	const matches = $derived(
		findSettings(query, {
			signedIn: !!session,
			account: !!session?.userId,
			admin,
			android,
			ios: Capacitor.getPlatform() === 'ios',
			offline: offlineSupported
		})
	);
	const title = $derived(page === 'menu' ? 'Settings' : pageTitles[page]);
	async function readRole() {
		if (
			!session ||
			!navigator.onLine ||
			(offlineSupported && (await preferredOffline(session).catch(() => false)))
		)
			return;
		roleError = '';
		try {
			admin =
				(await getJson<components['schemas']['UserResponse']>(session, path('/api/v3/me'))).role ===
				'admin';
		} catch (e) {
			roleError = errorMessage(e);
		}
	}
	async function readVersion() {
		if (!session) return;
		versionError = '';
		try {
			version = (
				await getJson<components['schemas']['VersionInfo']>(session, path('/api/v3/version'))
			).version;
		} catch (e) {
			versionError = errorMessage(e);
		}
	}
	function focus(y = 0) {
		void tick().then(() => {
			const m = root?.closest('main');
			m?.scrollTo(0, y);
			m?.focus({ preventScroll: true });
		});
	}
	function open(next: Page, anchor?: string) {
		changeScreen(() => {
			offset = root?.closest('main')?.scrollTop ?? 0;
			page = next;
			focus();
			if (next === 'about') void readVersion();
			searchAnchor = anchor ?? '';
		});
	}
	$effect(() => {
		const anchor = searchAnchor;
		if (!anchor || page === 'menu') return;
		let watching = true;
		const events = new AbortController();
		const observer = new MutationObserver(reveal);
		function stop() {
			watching = false;
			observer.disconnect();
			events.abort();
		}
		function reveal() {
			if (!watching) return;
			const element = document.getElementById(anchor);
			if (!element || !root?.contains(element)) return;
			stop();
			if (element instanceof HTMLDetailsElement) element.open = true;
			element.tabIndex = -1;
			element.focus({ preventScroll: true });
			element.scrollIntoView({ block: 'start' });
		}
		// Some settings appear once Android has returned their stored values.
		observer.observe(root, { childList: true, subtree: true });
		root.addEventListener('pointerdown', stop, { signal: events.signal, once: true });
		root.addEventListener('keydown', stop, { signal: events.signal, once: true });
		void tick().then(reveal);
		return stop;
	});
	export function goBack() {
		if (page === 'menu') return false;
		if (page === 'player') {
			onplayerlayoutclose();
			return true;
		}
		changeScreen(() => {
			page = 'menu';
			focus(offset);
		});
		return true;
	}
	function back() {
		if (!goBack()) onback();
	}
	async function signOut() {
		busy = true;
		try {
			await onsignout();
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		if (initial !== 'menu') page = initial;
		void readRole();
		if (android) {
			updateFeed = watchAndroidUpdates(
				(state) => {
					updateState = state;
					updateError = '';
				},
				(error) => {
					updateError =
						error instanceof Error ? error.message : 'Could not read the Android update status.';
				}
			);
			return updateFeed.stop;
		}
	});
</script>

{#snippet groupHeading(label: string)}
	<svelte:element this={session ? 'h3' : 'h2'} class="settings-group-heading"
		>{uiText(label)}</svelte:element
	>
{/snippet}

<section class="settings" data-part="settings" bind:this={root}>
	{#if session && (page === 'home' || page === 'discover' || page === 'library' || page === 'player')}
		{#key page}<BoardSettings {session} board={page} onback={back} />{/key}
	{:else}
		<button aria-label={uiText('Back')} class="text-button back" data-screen-link onclick={back}
			><ChevronLeft size={18} />{page === 'menu' ? uiText('Back') : uiText('Settings')}</button
		>
		<h1 class="settings-title">
			{page === 'menu' ? (session ? uiText('Navigation') : uiText('Settings')) : uiText(title)}
		</h1>
		{#if page === 'menu'}
			{#if session}
				<nav class="shortcuts" aria-label={uiText('Navigation shortcuts')}>
					{#each shortcuts as item (item.id)}<button
							class="shortcut"
							data-surface="panel"
							data-screen-link
							onclick={() => onnavigate(item.id)}
							><item.icon size={21} /><span>{uiText(item.label)}</span></button
						>{/each}
				</nav>
				<h2 class="settings-heading">{uiText('Settings')}</h2>
			{/if}
			<input
				type="search"
				aria-label={tr('Search settings', '設定を検索')}
				placeholder={tr('Search settings', '設定を検索')}
				bind:value={query}
			/>
			{#if query.trim()}
				{#if matches.length}
					<div
						class="settings-list settings-results"
						data-surface="panel"
						aria-label={tr('Matching settings', '検索結果')}
					>
						{#each matches as result (result.page + (result.anchor ?? ''))}
							{#if result.page === 'outputs'}<Outputs settingsEntry />
							{:else}<button
									class="settings-entry"
									data-screen-link
									aria-label={uiText(result.label)}
									onclick={() => {
										if (result.page !== 'outputs') open(result.page, result.anchor);
									}}
								>
									<span
										>{uiText(result.label)}{#if result.anchor}<small
												>{uiText(pageTitles[result.page])}</small
											>{/if}</span
									><ChevronRight size={16} />
								</button>{/if}
						{/each}
					</div>
				{:else}<p role="status">{tr('No matching settings.', '該当する設定はありません。')}</p>{/if}
			{:else}
				{#if session}
					{@render groupHeading('Screen layouts')}
					<div class="settings-list" data-surface="panel">
						{#each layouts as item (item.id)}<button
								class="settings-entry"
								data-screen-link
								aria-label={uiFormat('Edit {name} layout', { name: uiText(item.label) })}
								onclick={() => open(item.id)}
								><item.icon size={19} /><span>{uiText(item.label)}</span><ChevronRight
									size={16}
								/></button
							>{/each}
					</div>{/if}
				{@render groupHeading('Appearance')}
				<div class="settings-list" data-surface="panel">
					<button class="settings-entry" data-screen-link onclick={() => open('language')}
						><Globe size={19} /><span>{uiText('App language')}</span><ChevronRight
							size={16}
						/></button
					>
					<button class="settings-entry" data-screen-link onclick={() => open('themes')}
						><Palette size={19} /><span>{uiText('Themes')}</span><ChevronRight size={16} /></button
					>
					<button class="settings-entry" data-screen-link onclick={() => open('interface')}
						><SlidersHorizontal size={19} /><span>{uiText('Interface and navigation')}</span
						><ChevronRight size={16} /></button
					>
				</div>
				{#if session}
					{@render groupHeading('Playback')}
					<div class="settings-list" data-surface="panel">
						<Outputs settingsEntry />
						{#if session.userId}<button
								class="settings-entry"
								data-screen-link
								onclick={() => open('handoff')}
								><Disc3 size={19} /><span>{uiText('Player handoff')}</span><ChevronRight
									size={16}
								/></button
							>{/if}
						<button class="settings-entry" data-screen-link onclick={() => open('playback')}
							><Music2 size={19} /><span>{uiText('Streaming and fades')}</span><ChevronRight
								size={16}
							/></button
						>
						<button class="settings-entry" data-screen-link onclick={() => open('queue')}
							><ListMusic size={19} /><span>{uiText(pageTitles.queue)}</span><ChevronRight
								size={16}
							/></button
						>
						{#if offlineSupported}<button
								class="settings-entry"
								data-screen-link
								onclick={() => open('offline')}
								><Layers size={19} /><span>{uiText('Offline and cache')}</span><ChevronRight
									size={16}
								/></button
							>{/if}
						{#if Capacitor.isNativePlatform()}<button
								class="settings-entry"
								data-screen-link
								onclick={() => open('equalizer')}
								><SlidersHorizontal size={19} /><span>{uiText('Equalizer')}</span><ChevronRight
									size={16}
								/></button
							>{/if}
					</div>
				{/if}
				{#if session}
					{@render groupHeading('Your account')}
					<div class="settings-list" data-surface="panel">
						{#each personal as item (item.id)}<button
								class="settings-entry"
								data-screen-link
								onclick={() => open(item.id)}
								><item.icon size={19} /><span>{uiText(item.label)}</span><ChevronRight
									size={16}
								/></button
							>{/each}
					</div>
					{#if admin}{@render groupHeading('Server administration')}
						<div class="settings-list" data-surface="panel">
							{#each administration as item (item.id)}<button
									class="settings-entry"
									data-screen-link
									onclick={() => open(item.id)}
									><item.icon size={19} /><span>{uiText(item.label)}</span><ChevronRight
										size={16}
									/></button
								>{/each}
						</div>{/if}
					{#if roleError}<p role="alert">{roleError}</p>
						<button class="text-button" onclick={readRole}>{uiText('Reload permissions')}</button
						>{/if}
				{/if}
				{@render groupHeading('App')}
				<div class="settings-list" data-surface="panel">
					{#if android}
						<button class="settings-entry" data-screen-link onclick={() => open('updates')}
							><Download size={19} /><span
								>{uiText('App updates')}{#if updateState?.offer && updateState.available}
									<small class="update-available"
										>{updateState.available.version} {uiText('available')}</small
									>
								{/if}</span
							><ChevronRight size={16} /></button
						>
					{/if}
					<button class="settings-entry" data-screen-link onclick={() => open('about')}
						><Info size={19} /><span>{uiText('About')}</span><ChevronRight size={16} /></button
					>
				</div>
				{#if session}<p class="server">{session.serverUrl}</p>
					<button class="secondary" disabled={busy} onclick={signOut}>{uiText('Sign out')}</button
					>{/if}
			{/if}
		{:else}
			<div class="settings-content">
				{#if page === 'equalizer' && session && Capacitor.isNativePlatform()}<EqualizerSettings />
				{:else if page === 'language'}
					<label class="language-choice"
						>{uiText('App language')}
						<InlineChoice selected={$languageChoice} label={uiText('App language')}
							><select
								value={$languageChoice}
								onchange={(e) => void chooseLanguage(e.currentTarget.value as LanguageChoice)}
							>
								<option value="system">{tr('Device language', '端末の言語に合わせる')}</option
								><option value="en" lang="en">English</option><option value="ja" lang="ja"
									>日本語</option
								>
							</select></InlineChoice
						>
					</label>
					{#if languageIssue}<p role="alert">{languageIssue}</p>{/if}
				{:else if page === 'interface'}<InterfaceSettings {session} offline={offlineSupported} />
				{:else if page === 'offline' && session && offlineSupported}<OfflineSettings {session} />
				{:else if page === 'playback' && session}<PlaybackSettings {session} />
				{:else if page === 'queue' && session}<QueueSettings {session} />
				{:else if page === 'handoff' && session}<LinkedPlayers />
				{:else if page === 'themes'}<ThemeSettings {session} />
				{:else if page === 'updates' && android}<UpdateSettings
						snapshot={updateState}
						readError={updateError}
						onrefresh={() => updateFeed?.refresh()}
					/>
				{:else if page === 'account' && session}<Account {session} />
				{:else if page === 'content' && session}<ServerSections {session} {admin} />
				{:else if page === 'tools' && session}<WebTools {session} {admin} />
				{:else if session && (page === 'stats' || (page === 'diagnostics' && admin))}<Statistics
						{session}
						diagnostics={page === 'diagnostics'}
					/>
				{:else if page === 'scans' && session && admin}<LibraryScans {session} />
				{:else if (page === 'editions' || page === 'releases') && session && admin}<ReleaseSettings
						{session}
						editions={page === 'editions'}
					/>
				{:else if page === 'about'}<dl class="settings-facts" data-surface="panel">
						<div>
							<dt>{uiText('Mobile app')}</dt>
							<dd>{pkg.version}</dd>
						</div>
						{#if session}<div>
								<dt>{uiText('Connected server')}</dt>
								<dd>{session.serverUrl}</dd>
							</div>
							<div>
								<dt>{uiText('DN version')}</dt>
								<dd>{version || '—'}</dd>
							</div>{/if}
					</dl>
					{#if versionError}<p role="alert">{versionError}</p>
						<button class="text-button" onclick={readVersion}
							>{uiText('Reload server version')}</button
						>{/if}
				{/if}
			</div>
		{/if}
	{/if}
</section>

<style>
	.settings > input[type='search'] {
		margin-block: 0.7rem;
		width: 100%;
	}
	.settings-results small {
		display: block;
		font-weight: 400;
		color: var(--muted);
	}
	.language-choice {
		display: grid;
		gap: 0.4rem;
	}
	.settings {
		max-width: 42rem;
		margin: auto;
		padding-bottom: var(--gap);
	}
	.back {
		margin-inline-start: -0.25rem;
	}
	.update-available {
		display: block;
		color: var(--accent);
		font-weight: 500;
	}
	.settings:has(> .shortcuts) {
		container-type: inline-size;
	}
	.shortcuts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.shortcuts .shortcut {
		flex: 1 0 max-content;
	}
	@container (max-width: 21.5em) {
		.shortcuts .shortcut {
			flex-basis: calc((100% - 0.8rem) / 3);
		}
	}
	@container (max-width: 15em) {
		.shortcuts .shortcut {
			flex-basis: calc((100% - 0.4rem) / 2);
		}
	}
	.shortcut {
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 0.35rem;
		min-height: 4.25rem;
		padding: 0.5rem 0.15rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-size: 0.82rem;
		font-weight: 600;
		line-height: 1.25;
		white-space: nowrap;
	}
	.shortcut :global(svg) {
		color: var(--accent);
	}
	.settings-heading {
		margin: 1.65rem 0 0;
		color: var(--heading);
		font-size: 1.6rem;
	}
	.settings-heading + :global(.settings-group-heading) {
		margin-top: 0.85rem;
	}
	.server {
		margin: 1rem 0 0.35rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
</style>
