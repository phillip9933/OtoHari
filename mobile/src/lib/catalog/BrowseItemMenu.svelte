<script lang="ts" module>
	export type BrowseAction =
		'play' | 'shuffle' | 'next' | 'upNext' | 'end' | 'offline' | 'playlist';
</script>

<script lang="ts">
	import { tr, uiText } from '../i18n';
	import { isPlaylistPinned, playlistShortcutLabel } from './launcherShortcuts';
	import type { BrowseItem, Category } from './libraryBrowse';
	import type { SmartPlaylist } from './smartPlaylists';
	import { offlineSupported } from '../offline/media';
	import PlaylistDialog from './PlaylistDialog.svelte';
	import type { Session } from '../connection';
	import HomePinButton from './HomePinButton.svelte';
	import { browsePin } from './homePins';
	let {
		row,
		session,
		category,
		offline = false,
		onclose,
		onopen,
		action,
		onpin,
		edit
	}: {
		row: BrowseItem;
		session: Session;
		category: Category;
		offline?: boolean;
		onclose: () => void;
		onopen: (row: BrowseItem) => void;
		action: (type: BrowseAction, row: BrowseItem) => void;
		onpin?: (remove: boolean) => void;
		edit?: (rule: SmartPlaylist) => void;
	} = $props();
	let pinned = $state<boolean | undefined>();
	$effect(() => {
		if (!onpin || category !== 'Playlists') return;
		let current = true;
		pinned = undefined;
		void isPlaylistPinned(session, row.id)
			.then((selected) => {
				if (current) pinned = selected;
			})
			.catch(() => {
				if (current) pinned = false;
			});
		return () => {
			current = false;
		};
	});
	const singular = {
		Albums: 'album',
		Artists: 'artist',
		Tracks: 'song',
		Genres: 'genre',
		Playlists: 'playlist'
	};
</script>

<PlaylistDialog title={row.title} {onclose}>
	<div class="choices">
		<button onclick={() => onopen(row)}
			>{tr('Open ' + singular[category], uiText(category) + 'を開く')}</button
		>
		<button onclick={() => action('play', row)}>{uiText('Play')}</button><button
			onclick={() => action('shuffle', row)}>{uiText('Shuffle')}</button
		>
		<button onclick={() => action('next', row)}>{uiText('Play next')}</button>
		<button onclick={() => action('upNext', row)}
			>{tr('Add to Up Next', '次の再生リストに追加')}</button
		>
		<button onclick={() => action('end', row)}>{uiText('Add to queue')}</button>
		{#if !offline}<button onclick={() => action('playlist', row)}
				>{uiText('Add to playlist')}</button
			>
			{#if offlineSupported}<button onclick={() => action('offline', row)}
					>{uiText('Save offline')}</button
				>{/if}
		{/if}
		{#if row.smart && edit}<button onclick={() => edit?.(row.smart!)}
				>{uiText('Edit smart playlist')}</button
			>{/if}
		<HomePinButton {session} compact pin={browsePin(row, category)} ondone={onclose} />
		{#if category === 'Playlists' && onpin}<button
				disabled={pinned === undefined}
				onclick={() => onpin?.(pinned === true)}>{playlistShortcutLabel(pinned === true)}</button
			>{/if}
	</div>
</PlaylistDialog>

<style>
	.choices {
		display: grid;
	}
	.choices button {
		min-height: 44px;
		padding: 0.4rem 0.3rem;
		text-align: start;
		border-bottom: 1px solid var(--line);
	}
</style>
