<script lang="ts">
	import { uiText } from '../i18n';
	import { onDestroy, type Snippet } from 'svelte';
	import {
		CheckCheck,
		Play,
		Shuffle,
		ListPlus,
		ListMusic,
		Download,
		ListEnd,
		X
	} from '@lucide/svelte';
	import { player, placementMessage, type PlayerTrack } from '../player';
	import { tr } from '../i18n';
	import type { Session } from '../connection';
	import { errorMessage, type OnPlay } from './catalog';
	import { queueSizeCheck } from './libraryQueue';
	import { beginPlaybackPreparation, shuffled } from './browseActions';
	import { offlineSupported, saveOfflineTracks } from '../offline/media';
	import AddToPlaylist from './AddToPlaylist.svelte';
	import {
		LibrarySelection,
		onLibrarySelectionBack,
		type LibraryChoice
	} from './librarySelection.svelte';

	let {
		session,
		onplay,
		children,
		heading,
		active = true,
		scope = '',
		enabled = true,
		tools,
		externalToggle = false,
		choices,
		contains,
		localOnly = false
	}: {
		session: Session;
		onplay: OnPlay;
		children: Snippet;
		heading?: string;
		active?: boolean;
		scope?: string;
		enabled?: boolean;
		tools?: Snippet;
		externalToggle?: boolean;
		choices?: () => LibraryChoice[];
		contains?: (id: string) => boolean;
		localOnly?: boolean;
	} = $props();
	const group = new LibrarySelection(
		() => active && enabled,
		() => choices?.(),
		() => !!choices
	);
	$effect(() => {
		if (contains)
			for (const id of group.selected.keys()) if (!contains(id)) group.selected.delete(id);
	});
	export function isSelecting() {
		return group.selecting;
	}
	let root: HTMLElement;

	let progress = $state('');
	let playlist = $state<PlayerTrack[] | null>(null),
		error = $state(''),
		request: AbortController | undefined;
	$effect(() => {
		void scope;
		if (!choices) void active;
		void session;
		request?.abort();
		group.close();
		group.busy = false;
		group.message = '';
		error = '';
		playlist = null;
	});
	$effect(() => {
		if (!active) request?.abort();
	});
	onDestroy(() => {
		request?.abort();
		group.drag.stop();
	});
	onLibrarySelectionBack(() => {
		if (!active || !group.selecting || !root?.getClientRects().length) return false;
		cancel();
		return true;
	});
	function cancel() {
		request?.abort();
		request = undefined;
		group.busy = false;
		group.close();
		group.message = '';
		error = '';
	}
	type Action = 'play' | 'shuffle' | 'next' | 'upNext' | 'queue' | 'playlist' | 'offline';
	async function apply(action: Action) {
		if (!group.selected.size || group.busy) return;
		error = '';
		group.message = '';
		group.busy = true;
		const controller = new AbortController();
		request = controller;
		progress = 'Preparing selected music…';
		let tracks: PlayerTrack[] = [];
		const forQueue = action !== 'offline' && action !== 'playlist';
		const checkSize = forQueue ? queueSizeCheck(session.serverUrl) : undefined;
		const finish = forQueue ? beginPlaybackPreparation(() => controller.abort()) : undefined;

		try {
			for (const item of [...group.selected.values()]) {
				controller.signal.throwIfAborted();
				const batch = await item.tracks(controller.signal, forQueue);
				controller.signal.throwIfAborted();
				if (!batch.length) throw Error('No playable library tracks in “' + item.title + '”.');
				for (const track of batch) {
					checkSize?.(track);
					tracks.push(track);
				}
			}
			if (action === 'shuffle') tracks = await shuffled(tracks, session);
			controller.signal.throwIfAborted();
			finish?.();
			if (action === 'playlist') {
				playlist = tracks;
				return;
			}
			if (action === 'play' || action === 'shuffle') await onplay(tracks, 0);
			else if (action === 'offline') {
				const result = await saveOfflineTracks(
					session,
					tracks,
					(done, total) => {
						if (!controller.signal.aborted) progress = 'Saving offline · ' + done + ' of ' + total;
					},
					controller.signal
				);
				if (!controller.signal.aborted) group.message = result.message;
			} else {
				const placement = action === 'queue' ? 'end' : action;
				await player.enqueue(tracks, session, placement);
				if (!controller.signal.aborted) group.message = placementMessage(placement);
			}
			if (!controller.signal.aborted) group.close();
		} catch (e) {
			if (!controller.signal.aborted) error = errorMessage(e);
		} finally {
			finish?.();
			if (request === controller) {
				request = undefined;
				group.busy = false;
			}
		}
	}
</script>

<div bind:this={root} class="collection" data-selection-group class:choosing={group.selecting}>
	{#if heading}<h1>{heading}</h1>{/if}
	{#if tools && (!group.selecting || externalToggle)}<div
			class="tools"
			class:category-controls={externalToggle}
		>
			{@render tools()}
		</div>{/if}
	{#if group.selecting}
		<div
			class="toolbar"
			data-selection-toolbar
			data-surface="panel"
			role="group"
			aria-label={uiText('Selection actions')}
		>
			<div class="summary">
				<button aria-label={uiText('Cancel selection')} onclick={cancel}><X size={20} /></button
				><strong aria-live="polite">{group.selected.size} {uiText('selected')}</strong>
				<button
					disabled={group.busy}
					onclick={() => {
						for (const item of group.listed()) group.selected.set(item.id, item);
					}}><CheckCheck size={17} /> {uiText('Select loaded')}</button
				>
				{#if group.selected.size}<button
						disabled={group.busy}
						onclick={() => group.selected.clear()}>{uiText('Clear')}</button
					>{/if}
			</div>
			<div class="actions">
				<button
					class="secondary"
					disabled={group.busy || !group.selected.size}
					onclick={() => apply('play')}><Play size={17} />{uiText('Play')}</button
				>
				<button
					class="secondary"
					disabled={group.busy || !group.selected.size}
					onclick={() => apply('shuffle')}><Shuffle size={17} />{uiText('Shuffle')}</button
				>
				<button
					class="secondary"
					disabled={group.busy || !group.selected.size}
					aria-label={uiText('Play next')}
					title={uiText('Play next')}
					onclick={() => apply('next')}
					><ListEnd size={17} /><span class="full-label">{uiText('Play next')}</span><span
						class="short-label">{uiText('Next')}</span
					></button
				>

				<button
					class="secondary"
					disabled={group.busy || !group.selected.size}
					onclick={() => apply('upNext')}
				>
					<ListPlus size={17} />{tr('Up Next', '次の再生リスト')}
				</button>

				<button
					class="secondary"
					disabled={group.busy || !group.selected.size}
					aria-label={uiText('Add to queue')}
					title={uiText('Add to queue')}
					onclick={() => apply('queue')}
					><ListPlus size={17} /><span class="full-label">{uiText('Add to queue')}</span><span
						class="short-label">{uiText('Queue')}</span
					></button
				>
				{#if !localOnly}<button
						class="secondary"
						disabled={group.busy || !group.selected.size}
						aria-label={uiText('Add to playlist')}
						title={uiText('Add to playlist')}
						onclick={() => apply('playlist')}
						><ListMusic size={17} /><span class="full-label">{uiText('Add to playlist')}</span><span
							class="short-label">{uiText('Playlist')}</span
						></button
					>
				{/if}{#if offlineSupported && !localOnly}<button
						class="secondary"
						disabled={group.busy || !group.selected.size}
						aria-label={uiText('Save offline')}
						title={uiText('Save offline')}
						onclick={() => apply('offline')}
						><Download size={17} /><span class="full-label">{uiText('Save offline')}</span><span
							class="short-label">{uiText('Offline')}</span
						></button
					>{/if}
			</div>
			{#if group.busy}<p role="status">{progress}</p>{/if}
		</div>
	{/if}
	{#if error}<p role="alert">{error}</p>{/if}
	{#if group.message}<p role="status">{group.message}</p>{/if}
	{@render children()}
</div>
{#if playlist}<AddToPlaylist
		{session}
		tracks={playlist}
		onclose={() => {
			playlist = null;
		}}
	/>{/if}

<style>
	.collection :global([data-selectable]) {
		user-select: none;
		-webkit-touch-callout: none;
	}
	.tools:empty {
		display: none;
	}
	.tools:not(:empty):not(.category-controls) {
		margin-block: 0 0.7rem;
	}
	.tools,
	.summary,
	.actions {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		gap: 0.35rem;
		padding: 0.35rem 0.55rem;
	}
	.short-label {
		display: none;
	}
	.summary button {
		min-width: 44px;
	}
	.toolbar {
		container-type: inline-size;
		position: sticky;
		top: 0;
		z-index: 2;
		margin-block: 0.3rem var(--gap);
		padding: 0.4rem;
		background: var(--bg);
		border-block: 1px solid var(--line);
	}
	.summary strong {
		flex: 1 1 auto;
	}
	@container (max-width: 32rem) {
		.summary {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr) auto auto;
			gap: 2px;
		}
		.summary button {
			padding-inline: 0.25rem;
		}
		.summary button,
		.summary strong {
			font-size: 0.85rem;
		}
		.actions {
			display: grid;
			grid-auto-flow: column;
			grid-auto-columns: minmax(0, 1fr);
			gap: 0.28rem;
		}
		.actions button.secondary {
			width: 100%;
			min-width: 0;
			min-height: 48px;
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			justify-items: center;
			align-content: center;
			gap: 0.2rem;
			padding: 0.2rem 0;
			font-size: 0.76rem;
			line-height: 1.1;
		}
		.short-label {
			display: inline;
		}
		.full-label {
			display: none;
		}
	}
	.collection :global([data-preview='grid'] button[data-selecting]) {
		border-radius: var(--radius);
	}
	.collection :global(button[data-selecting]) {
		position: relative;
		outline: 1px solid var(--line);
		outline-offset: -2px;
	}
	.collection :global(button[data-selecting][aria-pressed='true']) {
		outline: 2px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, var(--bg));
	}
	.collection :global(button[data-selecting][aria-pressed='true'])::after {
		content: '✓';
		position: absolute;
		right: 0.45rem;
		top: 0.45rem;
		color: var(--on-accent);
		background: var(--accent);
		border-radius: 50%;
		width: 1.4rem;
		height: 1.4rem;
		display: grid;
		place-items: center;
		font-weight: 700;
	}
	.choosing :global([data-preview-item] > .icon-button),
	.choosing :global([data-part='track-list'] .row > .icon-button) {
		display: none;
	}
</style>
