<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { playBuild } from '../distribution';
	import { Capacitor } from '@capacitor/core';
	import { uiText, tr, languageChoice, setLanguage, type LanguageChoice } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { findSettings, pageTitles, type SettingsPage as Page } from './settingsSearch';
	import InterfaceSettings from './InterfaceSettings.svelte';
	import './settings.css';
	import { shortcuts, changeScreen, type Destination } from './interface';
	import Outputs from '../player/Outputs.svelte';
	import OfflineSettings from '../offline/OfflineSettings.svelte';
	import { nativeOffline, offlineSupported, preferredOffline } from '../offline/media';
	import PlaybackSettings from '../player/PlaybackSettings.svelte';
	import QueueSettings from '../player/QueueSettings.svelte';
	import LinkedPlayers from '../../../../frontend/src/lib/features/player/components/LinkedPlayers.svelte';
	import SoundSettings from '../player/SoundSettings.svelte';
	import FadeSettings from '../player/FadeSettings.svelte';
	import DeviceDiagnostics from '../offline/DeviceDiagnostics.svelte';
	import OfflineHistory from '../offline/AndroidHistorySettings.svelte';
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
		Volume2,
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
	import playPrivacy from '../../../PRIVACY-PLAY.md?raw';
	const playPrivacyParagraphs = playBuild ? playPrivacy.trim().split(/\n\s*\n/).slice(1) : [];
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
	const supportsPlayerPreferences = Capacitor.getPlatform() !== 'ios';
	let searchAnchor = $state(''),
		returnQuery = $state('');
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
			returnQuery = next === 'menu' && anchor ? query : '';
			if (returnQuery) query = '';
			page = next;
			focus();
			if (next === 'about') void readVersion();
			searchAnchor = anchor ?? '';
		});
	}
	$effect(() => {
		const anchor = searchAnchor;
		if (!anchor) return;
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
			for (
				let disclosure = element.closest('details');
				disclosure;
				disclosure = disclosure.parentElement?.closest('details') ?? null
			)
				disclosure.open = true;
			if (element.tabIndex < 0) element.tabIndex = -1;
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
		if (page === 'menu') {
			if (!returnQuery) return false;
			query = returnQuery;
			returnQuery = '';
			searchAnchor = '';
			focus(offset);
			return true;
		}
		if (page === 'player') {
			onplayerlayoutclose();
			return true;
		}
		changeScreen(() => {
			page = 'menu';
			searchAnchor = '';
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
		if (android && !playBuild) {
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

{#snippet link(id: Exclude<Page, 'menu'>, Icon: typeof House)}
	<button class="settings-entry" data-screen-link onclick={() => open(id)}>
		<Icon size={19} /><span
			>{uiText(pageTitles[id])}
			{#if id === 'updates' && updateState?.offer && updateState.available}
				<small class="update-available">{updateState.available.version} {uiText('available')}</small
				>
			{/if}
		</span><ChevronRight size={16} />
	</button>
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
				oninput={() => {
					searchAnchor = '';
					returnQuery = '';
				}}
			/>
			{#if query.trim() && !searchAnchor}
				{#if matches.length}
					<div
						class="settings-list settings-results"
						data-surface="panel"
						aria-label={tr('Matching settings', '検索結果')}
					>
						{#each matches as result (result.page + (result.anchor ?? ''))}
							{#if result.page === 'outputs'}<Outputs
									settingsEntry
									breadcrumb={result.breadcrumb.map(uiText).join(' → ')}
								/>
							{:else}<button
									class="settings-entry"
									data-screen-link
									aria-label={uiText(result.label)}
									onclick={() => {
										if (result.page !== 'outputs') open(result.page, result.anchor);
									}}
								>
									<span
										>{uiText(result.label)}<small>{result.breadcrumb.map(uiText).join(' → ')}</small
										></span
									>
									<ChevronRight size={16} />
								</button>{/if}
						{/each}
					</div>
				{:else}<p role="status">{tr('No matching settings.', '該当する設定はありません。')}</p>{/if}
			{:else}
				{@render groupHeading('Appearance & layout')}
				<div class="settings-list" data-surface="panel">
					{#if session}
						{@render link('home', House)}
						{@render link('library', LibraryBig)}
						{@render link('discover', Compass)}
						{@render link('player', Disc3)}
						{#if session.userId}{@render link('mini', Music2)}{/if}
					{/if}
					{@render link('themes', Palette)}
					{@render link('interface', SlidersHorizontal)}
					{@render link('navigation', ListMusic)}
				</div>
				{#if session}
					{@render groupHeading('Playback')}
					<div class="settings-list" data-surface="panel">
						{@render link('playback', Music2)}
						{@render link('fades', SlidersHorizontal)}
						{#if supportsPlayerPreferences}{@render link('sound', Volume2)}{/if}
						<Outputs settingsEntry />
						{#if session.userId && supportsPlayerPreferences}{@render link('handoff', Disc3)}{/if}
					</div>
					{#if supportsPlayerPreferences}<QueueSettings {session} />{/if}
					{#if offlineSupported}
						{@render groupHeading('Downloads & storage')}
						<div class="settings-list" data-surface="panel">
							{@render link('offline', Music2)}
							{@render link('downloads', Download)}
							{@render link('storage', Layers)}
						</div>
					{/if}
					{@render groupHeading('Library')}
					<div class="settings-list" data-surface="panel">{@render link('stats', LibraryBig)}</div>
					{@render groupHeading('Account')}
					<div class="settings-list" data-surface="panel">
						{@render link('account', UserRound)}
						{@render link('content', SlidersHorizontal)}
						{#if nativeOffline && session.userId}{@render link('history', ListMusic)}{/if}
					</div>
					<div class="session-info">
						<div><small>{uiText('Connected server')}</small><span>{session.serverUrl}</span></div>
						<button id="account-sign-out" class="secondary" disabled={busy} onclick={signOut}
							>{uiText('Sign out')}</button
						>
					</div>
				{/if}
				{@render groupHeading('App')}
				<div class="settings-list" data-surface="panel">
					{@render link('language', Globe)}
					{#if android && !playBuild}{@render link('updates', Download)}{/if}
					{#if session && nativeOffline && session.userId}{@render link(
							'troubleshooting',
							Activity
						)}{/if}
					{#if session}{@render link('tools', Globe)}{/if}
					{@render link('about', Info)}
				</div>
				{#if session && admin}
					{@render groupHeading('Server administration')}
					<div class="settings-list" data-surface="panel">
						{@render link('diagnostics', Activity)}
						{@render link('scans', LibraryBig)}
						{@render link('releases', Music2)}
						{@render link('editions', Layers)}
					</div>
				{/if}
				{#if roleError}<p role="alert">{roleError}</p>
					<button class="text-button" onclick={readRole}>{uiText('Reload permissions')}</button
					>{/if}
			{/if}
		{:else}
			<div class="settings-content">
				{#if page === 'language'}
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
				{:else if page === 'interface' || page === 'navigation' || page === 'mini'}
					<InterfaceSettings
						{session}
						offline={offlineSupported}
						section={page === 'interface' ? 'style' : page}
					/>
				{:else if (page === 'offline' || page === 'downloads' || page === 'storage') && session && offlineSupported}
					<OfflineSettings {session} view={page} />
				{:else if page === 'history' && session?.userId && nativeOffline}<OfflineHistory
						{session}
					/>
				{:else if page === 'troubleshooting' && session?.userId && nativeOffline}<DeviceDiagnostics
						{session}
					/>
				{:else if page === 'playback' && session}<PlaybackSettings {session} />
				{:else if page === 'fades' && session}<FadeSettings />
				{:else if page === 'sound' && session && supportsPlayerPreferences}<SoundSettings />
				{:else if page === 'handoff' && session}<LinkedPlayers />
				{:else if page === 'themes'}<ThemeSettings {session} />
				{:else if page === 'updates' && android && !playBuild}<UpdateSettings
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
				{:else if page === 'about'}
					<p>{uiText('OtoHari is an unofficial music player for DroppedNeedle.')}</p>
					{#if playBuild}
						<details>
							<summary>{tr('Privacy policy', 'プライバシーポリシー')}</summary>
							<p>
								<a
									href="https://github.com/phillip9933/OtoHari/blob/main/mobile/PRIVACY-PLAY.md"
									target="_blank"
									rel="noopener noreferrer"
								>{tr('Read the privacy policy online', 'プライバシーポリシーをオンラインで読む')}</a>
							</p>
							{#each playPrivacyParagraphs as paragraph (paragraph)}
								{#if paragraph.startsWith('## ')}<h3>{paragraph.slice(3)}</h3>
								{:else}<p>{paragraph}</p>{/if}
							{/each}
						</details>
					{/if}
					<dl class="settings-facts" data-surface="panel">
						<div>
							<dt>{uiText('OtoHari version')}</dt>
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
	.session-info {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--gap);
		margin-top: 0.6rem;
	}
	.session-info div {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.session-info small {
		display: block;
		color: var(--muted);
	}
	.session-info button {
		flex: none;
	}
</style>
