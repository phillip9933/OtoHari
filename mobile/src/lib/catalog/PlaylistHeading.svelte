<script lang="ts">
	import { tr } from '../i18n';
	import type { Session } from '../connection';
	import type { Playlist } from './playlists';
	import PlaylistCover from './PlaylistCover.svelte';
	import PlaylistCoverPicker from './PlaylistCoverPicker.svelte';
	import PlaylistDialog from './PlaylistDialog.svelte';
	let {
		session,
		id,
		title,
		covers,
		cacheOnly = false,
		playlist,
		onchanged
	}: {
		session: Session;
		id: string;
		title: string;
		covers?: string[];
		cacheOnly?: boolean;
		playlist?: Playlist;
		onchanged?: () => void;
	} = $props();
	let editing = $state(false);
	const editable = $derived(id.startsWith('smart:') || (!cacheOnly && playlist?.is_owner === true));
</script>

{#snippet art()}<PlaylistCover {session} {id} {covers} {cacheOnly} />{/snippet}
<div class="playlist-heading">
	{#if editable}
		<button
			class="artwork"
			type="button"
			aria-label={tr('Change playlist artwork', 'プレイリストの画像を変更')}
			onclick={() => (editing = true)}
		>
			{@render art()}
		</button>
	{:else}<div class="artwork">{@render art()}</div>{/if}
	<h1>{title}</h1>
</div>
{#if editing && editable}
	<PlaylistDialog
		title={tr('Playlist artwork', 'プレイリストの画像')}
		onclose={() => (editing = false)}
	>
		<div class="options">
			<PlaylistCoverPicker
				{session}
				{id}
				{playlist}
				ondone={() => {
					editing = false;
					onchanged?.();
				}}
			/>
		</div>
		<button type="button" class="text-button" onclick={() => (editing = false)}
			>{tr('Done', '完了')}</button
		>
	</PlaylistDialog>
{/if}

<style>
	.playlist-heading {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		margin-block: 0.5rem 1rem;
	}
	.artwork {
		width: clamp(3rem, 15vw, 5rem);
		flex: none;
		padding: 0;
	}
	h1 {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.options {
		display: grid;
	}
</style>
