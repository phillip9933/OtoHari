<script lang="ts">
	import { japaneseText, tr, uiText } from '../i18n';
	import { Browser } from '@capacitor/browser';
	import { playBuild } from '../distribution';
	import { ExternalLink } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { Session } from '../connection';
	let { session, admin }: { session: Session; admin: boolean } = $props();
	let filter = $state(''),
		error = $state('');
	const expanded = new SvelteSet<string>();
	const collapsedResults = new SvelteSet<string>();
	const query = $derived(filter.trim().normalize('NFKC').toLowerCase());
	const heading = (title: string) =>
		title === 'System' ? tr('System', 'システム') : uiText(title);
	const tab = (label: string, id: string) => ({ label, route: '/settings?tab=' + id });
	const groups = $derived(
		[
			{
				title: 'Your account',
				links: [
					{ label: 'Account security and avatar', route: '/profile#account' },
					{ label: 'Connect apps', route: '/profile#connect-apps' },
					{ label: 'Connected services', route: '/profile#connected-services' },
					{ label: 'Custom CSS and saved styles', route: '/profile#appearance' },
					{ label: 'Profile and linked media accounts', route: '/profile' },
					{ label: 'Listening and scrobbling', route: '/profile#scrobbling' },
					{ label: 'Spotify connection', route: '/profile#spotify' },
					{ label: 'Your libraries', route: '/profile#libraries' }
				]
			},
			...(admin
				? [
						{
							title: 'Library management',
							links: [
								{ label: 'Library settings and roots', route: '/settings/library' },
								{ label: 'Manage library', route: '/library/management' },
								{ label: 'Manage artists', route: '/library/management/artists' },
								{ label: 'Operation history', route: '/library/management/history' },
								{ label: 'Review matches', route: '/library/review' },
								{ label: 'Unmatched files', route: '/library/unmatched' },
								{ label: 'Duplicates', route: '/library/duplicates' },
								{ label: 'Recycle bin', route: '/library/recycle-bin' }
							]
						},
						{
							title: 'Server setup',
							links: [
								tab('Library', 'library'),
								tab('Editions', 'editions'),
								...(!playBuild ? [tab('Download client', 'download-client')] : []),
								...(!playBuild ? [tab('Indexers and Prowlarr', 'indexers')] : []),
								...(!playBuild ? [tab('Lidarr import', 'lidarr-import')] : []),
								tab('Connected apps', 'connect-apps'),
								tab('Jellyfin', 'jellyfin'),
								tab('Navidrome', 'navidrome'),
								tab('Plex', 'plex'),
								...(!playBuild ? [tab('YouTube', 'youtube')] : []),
								tab('Last.fm', 'lastfm'),
								tab('ListenBrainz', 'listenbrainz'),
								tab('Spotify', 'spotify'),
								tab('Live events', 'events'),
								...(!playBuild ? [tab('Get it', 'get-it')] : [])
							]
						},
						{
							title: 'Server personalization',
							links: [
								tab('Release types', 'settings'),
								tab('Web appearance', 'appearance'),
								...(!playBuild ? [tab('Music source', 'music-source')] : []),
								tab('Sidebar', 'sidebar'),
								tab('Home', 'home'),
								tab('Discover', 'discover')
							]
						},
						{
							title: 'System',
							links: [
								tab('Cache', 'cache'),
								tab('MusicBrainz', 'musicbrainz'),
								tab('Users', 'users'),
								tab('Backups', 'backups'),
								tab('Security', 'security'),
								tab('Plugins', 'plugins'),
								tab('Wrapped API', 'wrapped'),
								tab('Diagnostics', 'diagnostics'),
								tab('Advanced', 'advanced'),
								tab('About server', 'about')
							]
						}
					]
				: [
						{
							title: 'Content preferences',
							links: [tab('Home', 'home'), tab('Discover', 'discover')]
						}
					])
		]
			.map((g) => ({
				...g,
				links: g.links.filter((l) =>
					[
						g.title,
						g.title === 'System' ? 'システム' : japaneseText(g.title),
						l.label,
						japaneseText(l.label)
					]
						.join(' ')
						.normalize('NFKC')
						.toLowerCase()
						.includes(query)
				)
			}))
			.filter((g) => g.links.length)
	);
	function toggle(event: MouseEvent, title: string) {
		event.preventDefault();
		const choices = query ? collapsedResults : expanded;
		if (choices.has(title)) choices.delete(title);
		else choices.add(title);
	}
	async function open(e: MouseEvent, url: string) {
		e.preventDefault();
		error = '';
		try {
			await Browser.open({ url });
		} catch {
			error = tr('Could not open the browser.', 'ブラウザーを開けませんでした。');
		}
	}
</script>

<p>{uiText('These tools open on your DroppedNeedle server in the browser.')}</p>
<input
	type="search"
	aria-label={uiText('Find a web tool')}
	placeholder={uiText('Find a web tool')}
	value={filter}
	oninput={(event) => {
		filter = event.currentTarget.value;
		collapsedResults.clear();
	}}
/>
{#if error}<p role="alert">{error}</p>{/if}
{#each groups as group (group.title)}
	<details
		class="settings-disclosure"
		data-surface="panel"
		open={query ? !collapsedResults.has(group.title) : expanded.has(group.title)}
	>
		<summary onclick={(event) => toggle(event, group.title)}>{heading(group.title)}</summary>
		<div class="links">
			{#each group.links as link (link.route)}<a
					class="settings-entry"
					href={session.serverUrl + link.route}
					target="_blank"
					rel="noopener noreferrer"
					onclick={(e) => open(e, session.serverUrl + link.route)}
					><span>{uiText(link.label)}</span><ExternalLink size={15} /></a
				>{/each}
		</div>
	</details>
{/each}
{#if !groups.length}<p>{uiText('No matching tools.')}</p>{/if}

<style>
	input {
		width: 100%;
	}
	.links > a {
		border-block-start: 1px solid var(--line);
		padding-inline: 0;
	}
</style>
