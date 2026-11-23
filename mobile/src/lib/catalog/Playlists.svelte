<script lang="ts">
	import { tr, uiText } from '../i18n';
	import type { Preview } from '../boards/display';
	import type { Session } from '../connection';
	import { errorMessage } from './catalog';
	import { playlists, readPlaylist, playlistCover, type Playlist } from './playlists';
	import PreviewItem from '../boards/PreviewItem.svelte';
	import PlaylistEditor from './PlaylistEditor.svelte';
	import PlaylistImport from './PlaylistImport.svelte';
	let creating = $state(false),
		savedSmart = $state(false);
	let {
		display,
		session,
		preview = false,
		active = true,
		onopen
	}: {
		session: Session;
		display: Preview;
		preview?: boolean;
		active?: boolean;
		onopen: (playlist: Playlist) => void;
	} = $props();
	let items = $state<Playlist[]>([]);
	let count = $state(40);
	let busy = $state(true),
		error = $state('');
	let retry = $state(0);
	$effect(() => {
		const account = session;
		void retry;
		if (!active) return;
		let valid = true;
		async function load() {
			busy = true;
			error = '';
			try {
				const fresh = await playlists(account);
				if (valid) items = fresh;
			} catch (e) {
				if (valid) error = errorMessage(e);
			} finally {
				if (valid) busy = false;
			}
		}
		void load();
		return () => {
			valid = false;
		};
	});
</script>

{#if !preview}<button class="text-button" onclick={() => (creating = true)}
		>{uiText('New playlist')}</button
	><PlaylistImport {session} onimport={() => retry++} />{/if}
{#if creating}
	<PlaylistEditor
		{session}
		onclose={() => (creating = false)}
		oncreated={() => {
			creating = false;
			savedSmart = true;
		}}
		onblank={(item) => {
			creating = false;
			onopen(item);
		}}
	/>
{/if}
{#if savedSmart && !preview}<p role="status">
		{tr(
			'Smart playlist saved in Library → Playlists.',
			'ライブラリの「プレイリスト」に保存しました。'
		)}
	</p>{/if}
{#if busy}<p role="status">{uiText('Loading playlists…')}</p>
{:else if error}<p role="alert">{error}</p>
	<button class="secondary" onclick={() => retry++}>{uiText('Try again')}</button>
{:else if !items.length}<p>{uiText('No playlists yet.')}</p>
{:else}
	<div data-part="playlist-list" class="preview-items">
		{#each items.slice(0, preview ? display.limit : count) as item (item.id)}
			<PreviewItem
				{session}
				choice={{
					id: 'playlist:' + item.id,
					title: item.name,
					tracks: async (signal) => (await readPlaylist(session, item, signal)).tracks
				}}
				title={item.name}
				subtitle={item.track_count + (item.track_count === 1 ? ' track' : ' tracks')}
				artwork={playlistCover(item)}
				coverSeed={item.id}
				playlistId={'playlist:' + item.id}
				onclick={() => onopen(item)}
			/>
		{/each}
	</div>
	{#if !preview && count < items.length}<button class="secondary more" onclick={() => (count += 40)}
			>{uiText('More playlists')}</button
		>{/if}
{/if}

<style>
	.more {
		margin-top: var(--gap);
	}
</style>
