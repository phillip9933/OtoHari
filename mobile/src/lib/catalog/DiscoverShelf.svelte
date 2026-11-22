<script lang="ts">
	import type { Session } from '../connection';
	import type { Album } from './catalog';
	import type { Shelf, DiscoverArtistRef } from './discovery';
	import Albums from './Albums.svelte';
	import Cover from './Cover.svelte';
	let {
		session,
		shelf,
		onopen,
		onartist
	}: {
		session: Session;
		shelf: Shelf;
		onopen: (a: Album) => void;
		onartist: (a: DiscoverArtistRef) => void;
	} = $props();
</script>

{#if shelf.title}<h2>{shelf.title}</h2>{/if}
{#if shelf.albums.length}<Albums {session} albums={shelf.albums} {onopen} />{/if}
{#each shelf.artists as artist (artist.target?.id || artist.name)}
	{@const target = artist.target}
	{#if target}<button class="artist" onclick={() => onartist(target)}
			><span class="avatar"
				><Cover {session} path={artist.art} fallback={artist.fallbackArt} seed={target.id} /></span
			><strong>{artist.name}</strong></button
		>
	{:else}<p>{artist.name}</p>{/if}
{/each}
{#each shelf.unlinked as text, i (`${i}/${text}`)}<p>{text}</p>{/each}

<style>
	.artist {
		display: flex;
		align-items: center;
		text-align: start;
		width: 100%;
		gap: var(--gap);
		padding: 0.45rem 0;
		min-height: 48px;
		border-bottom: 1px solid var(--line);
		color: var(--text);
	}
	.avatar {
		flex: 0 0 2.7rem;
		border-radius: 50%;
		overflow: hidden;
	}
</style>
