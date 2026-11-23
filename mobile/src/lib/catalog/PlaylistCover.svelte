<script lang="ts">
	import { readable } from 'svelte/store';
	import { ListMusic } from '@lucide/svelte';
	import type { Session } from '../connection';
	import { playlistCoverOverride } from './playlistCoverOverrides';
	import Cover from './Cover.svelte';

	let {
		session,
		id,
		covers = [],
		cacheOnly = false
	}: {
		session: Session;
		id: string;
		covers?: string[];
		cacheOnly?: boolean;
	} = $props();
	const empty = readable<string | undefined>();
	const override = $derived(id.startsWith('smart:') ? playlistCoverOverride(session, id) : empty);
	const collage = $derived(covers.length > 1 && !$override);
</script>

<span class="playlist-cover" class:collage aria-hidden="true">
	{#if $override}<img src={$override} alt="" />
	{:else if covers.length}
		{#each collage ? Array.from({ length: 4 }, (_, i) => covers[i % covers.length]) : covers as art, i (i)}
			<Cover {session} {cacheOnly} path={art} seed={art} />
		{/each}
	{:else}<ListMusic strokeWidth={1.3} size="48%" />{/if}
</span>

<style>
	.playlist-cover {
		display: grid;
		place-items: center;
		width: 100%;
		aspect-ratio: 1;
		grid-template: minmax(0, 1fr) / minmax(0, 1fr);
		overflow: hidden;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--muted);
	}
	.collage {
		grid-template: repeat(2, minmax(0, 1fr)) / repeat(2, minmax(0, 1fr));
		gap: 1px;
	}
	img,
	.playlist-cover :global(.cover) {
		width: 100%;
		height: 100%;
		border-radius: 0;
		object-fit: cover;
	}
</style>
