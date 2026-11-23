<script lang="ts">
	import type { Snippet } from 'svelte';
	import { useLibrarySelection, type LibraryChoice } from '../catalog/librarySelection.svelte';
	import PlaylistCover from '../catalog/PlaylistCover.svelte';
	import Cover from '../catalog/Cover.svelte';
	import type { Session } from '../connection';

	const selectable = useLibrarySelection();
	let {
		session,
		title,
		subtitle,
		detail,
		time,
		artwork,
		fallbackArt,
		coverSeed,
		playlistId,
		cacheOnly = false,
		onclick,
		label,
		part,
		disabled = false,
		actions,
		choice
	}: {
		session: Session;
		title: string;
		subtitle?: string;
		detail?: string;
		time?: { value: string; label: string };
		artwork?: string;
		fallbackArt?: string;
		coverSeed?: string;
		playlistId?: string;
		cacheOnly?: boolean;
		onclick?: () => void;
		label?: string;
		part?: string;
		disabled?: boolean;
		actions?: Snippet;
		choice?: LibraryChoice;
	} = $props();
</script>

{#snippet content()}
	{#if coverSeed}<span class="art"
			>{#if playlistId}<PlaylistCover
					{session}
					id={playlistId}
					{cacheOnly}
					covers={artwork ? [artwork] : []}
				/>{:else}<Cover
					{session}
					{cacheOnly}
					path={artwork}
					fallback={fallbackArt}
					seed={coverSeed}
				/>{/if}</span
		>{/if}
	<span class="text"
		><strong>{title}</strong>{#if subtitle}<small>{subtitle}</small>{/if}{#if time}<small
				><time datetime={time.value}>{time.label}</time></small
			>{/if}{#if detail}<small>{detail}</small>{/if}</span
	>
{/snippet}
<div class="item" class:actions={!!actions} data-preview-item>
	{#if onclick}<button
			use:selectable={choice}
			class="body"
			data-part={part}
			aria-label={label}
			{onclick}
			{disabled}>{@render content()}</button
		>
	{:else}<div class="body" data-part={part}>{@render content()}</div>{/if}
	{#if actions}{@render actions()}{/if}
</div>

<style>
	.item {
		min-width: 0;
		display: flex;
		flex-wrap: wrap;
		container: preview-item / inline-size;
		align-items: center;
		gap: 0.25rem;
		border-bottom: 1px solid var(--line);
	}
	.body {
		min-width: 0;
		flex: 1 1 7rem;
		min-height: var(--preview-height);
		padding: var(--preview-padding) 0;
		display: flex;
		align-items: center;
		gap: var(--preview-gap);
		text-align: start;
		color: var(--text);
	}
	.art {
		display: block;
		width: var(--preview-art);
		flex-shrink: 0;
	}
	.text {
		display: grid;
		min-width: 0;
		line-height: 1.3;
		gap: 2px;
	}
	strong,
	small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	:global([data-collection='expanded']) small {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	small {
		color: var(--muted);
	}
	:global([data-preview='grid']) .item {
		background: transparent;
		border: 0;
		align-items: stretch;
		flex-direction: column;
		flex-wrap: nowrap;
		justify-content: flex-start;
	}
	:global([data-preview='grid']) .body {
		flex: 1;
		flex-direction: column;
		align-items: stretch;
		justify-content: flex-start;
		padding: 0;
		gap: var(--preview-gap);
	}
	:global([data-preview='grid']) .art {
		width: 100%;
	}
	:global([data-preview='grid']) .text {
		padding: 2px;
	}
	:global([data-preview='grid']) .actions > :global(.icon-button) {
		align-self: flex-end;
	}
	@container preview-item (max-width: 6.5rem) {
		:global([data-preview='list']) .art {
			display: none;
		}
		:global([data-preview='list']) .body {
			flex-basis: 100%;
		}
	}
</style>
