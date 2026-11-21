<script lang="ts">
	import { tr, uiText } from '../i18n';
	import { onDestroy, onMount } from 'svelte';
	import { Capacitor } from '@capacitor/core';
	import { CheckSquare, Download, Music2, Play, Trash2 } from '@lucide/svelte';
	import type { Session } from '../connection';
	import { player, placementMessage, type PlayerTrack } from '../player';
	import {
		LibrarySelection,
		trackChoice,
		useLibrarySelection
	} from '../catalog/librarySelection.svelte';
	import TrackActions from '../catalog/TrackActions.svelte';
	import FeedbackStatus from './FeedbackStatus.svelte';
	import ManualDownloads from './ManualDownloads.svelte';
	import {
		watchOfflineMedia,
		offlineSnapshot,
		removeOffline,
		saveOfflineTracks,
		storageSize,
		type OfflineItem
	} from './media';
	let {
		session,
		onplay
	}: { session: Session; onplay: (tracks: PlayerTrack[], index: number) => void | Promise<void> } =
		$props();
	let items = $state<OfflineItem[]>([]),
		view = $state<'downloaded' | 'automatic' | 'cached'>('downloaded'),
		filter = $state(''),
		remove = $state<string[] | null>(null),
		busy = $state(false),
		loading = $state(true),
		notice = $state(''),
		error = $state('');
	let section: HTMLElement;
	export function getPlaybackAvailability() {
		return view;
	}
	const matching = $derived(
		items.filter(
			(i) =>
				view === i.origin &&
				[i.track.title, i.track.artist, i.track.album]
					.join(' ')
					.toLocaleLowerCase()
					.includes(filter.trim().toLocaleLowerCase())
		)
	);
	const selection = new LibrarySelection(
		() => !busy && !remove,
		() => matching.map((i) => trackChoice(i.track, i.track.id)),
		() => true
	);
	const selectable = useLibrarySelection();
	const selected = $derived(selection.selecting ? [...selection.selected.keys()] : null);
	$effect(() => {
		const visible = new Set(matching.map((i) => i.track.id));
		for (const id of selection.selected.keys()) if (!visible.has(id)) selection.selected.delete(id);
	});
	onDestroy(() => selection.drag.stop());
	const picked = $derived(items.filter((i) => selected?.includes(i.track.id)).map((i) => i.track));
	async function read() {
		try {
			items = (await offlineSnapshot(session)).items;
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read offline music.';
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		void read();
		const stop = watchOfflineMedia(read);
		function back(event: Event) {
			if (!section?.getClientRects().length || (!remove && !selected)) return;
			if (remove) remove = null;
			else selection.close();
			event.preventDefault();
			event.stopImmediatePropagation();
		}
		window.addEventListener('dn-back', back, true);
		return () => {
			stop();
			window.removeEventListener('dn-back', back, true);
		};
	});
	function choose(next: typeof view) {
		if (busy) return;
		view = next;
		filter = '';
		selection.close();
		remove = null;
		notice = '';
	}
	async function run(action: () => Promise<unknown> | void, receipt = '') {
		if (busy) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await action();
			selection.close();
			remove = null;
			notice = typeof result === 'string' ? result : receipt;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not complete this action.';
		} finally {
			busy = false;
		}
	}
</script>

<section
	bind:this={section}
	aria-label={uiText('Offline music')}
	data-selection-group
	data-part="offline-music"
>
	<h1>{uiText('Offline music')}</h1>
	{#if ['android', 'ios'].includes(Capacitor.getPlatform()) && session.userId}
		{#key JSON.stringify([session.serverUrl, session.userId])}<ManualDownloads
				serverUrl={session.serverUrl}
				userId={session.userId}
			/>{/key}
	{/if}
	<FeedbackStatus {session} />
	<div class="bar" role="group" aria-label={uiText('Offline collection')}>
		<button aria-pressed={view === 'downloaded'} onclick={() => choose('downloaded')}
			>{uiText('Saved downloads')}</button
		><button aria-pressed={view === 'automatic'} onclick={() => choose('automatic')}
			>{uiText('Automatic downloads')}</button
		><button aria-pressed={view === 'cached'} onclick={() => choose('cached')}
			>{uiText('Playback cache')}</button
		>
	</div>
	{#if loading}<p role="status">{uiText('Reading offline music…')}</p>
	{:else}
		<div class="actions">
			{#if selected}
				<button
					class="secondary"
					onclick={() => {
						selection.close();
						remove = null;
					}}>{uiText('Cancel selection')}</button
				>
				<button
					class="secondary"
					onclick={() => {
						for (const i of matching)
							selection.selected.set(i.track.id, trackChoice(i.track, i.track.id));
					}}>{uiText('Select all')}</button
				>
			{:else if matching.length}
				<button
					class="secondary"
					onclick={() =>
						onplay(
							matching.map((i) => i.track),
							0
						)}><Play size={16} />{uiText('Play all')}</button
				>
			{/if}
			{#if matching.length}<button
					class="secondary"
					aria-pressed={selection.selecting}
					onclick={() => {
						remove = null;
						if (selection.selecting) selection.close();
						else selection.selecting = true;
					}}><CheckSquare size={16} />{uiText('Select songs')}</button
				>{/if}
		</div>
		{#if selected}<div class="actions" role="group" aria-label={uiText('Selected offline songs')}>
				<strong>{selected.length} {uiText('selected')}</strong>
				<button
					class="secondary"
					disabled={!picked.length || busy}
					onclick={() => run(() => onplay(picked, 0))}>{uiText('Play selected')}</button
				>
				<button
					class="secondary"
					disabled={!picked.length || busy}
					onclick={() => run(() => player.enqueue(picked, session, 'next'), 'Added to play next.')}
					>{uiText('Play next')}</button
				>
				<button
					class="secondary"
					disabled={!picked.length || busy}
					onclick={() =>
						run(() => player.enqueue(picked, session, 'upNext'), placementMessage('upNext'))}
					>{tr('Add to Up Next', '次の再生リストに追加')}</button
				>
				{#if view !== 'downloaded'}<button
						class="secondary"
						disabled={!picked.length || busy}
						onclick={() =>
							run(async () => {
								const result = await saveOfflineTracks(session, picked);
								if (result.failed) throw Error(result.message);
								return result.message;
							})}>{uiText('Keep downloads')}</button
					>{/if}
				<button
					class="secondary"
					disabled={!picked.length || busy}
					onclick={() => (remove = Array.from(selected ?? []))}>{uiText('Remove selected')}</button
				>
			</div>{/if}
		{#if remove}<div class="confirm" role="group" aria-label={uiText('Remove offline music')}>
				<p>
					{uiText('Remove')}
					{remove.length}
					{remove.length === 1 ? uiText('offline copy') : uiText('offline copies')}
					{uiText('from this device?')}
				</p>
				<button class="secondary" disabled={busy} onclick={() => (remove = null)}
					>{uiText('Keep music')}</button
				>
				<button
					class="primary"
					disabled={busy}
					onclick={() => {
						const ids = remove ?? [];
						void run(() => removeOffline(session, ids), 'Removed from this device.');
					}}>{uiText('Confirm removal')}</button
				>
			</div>{/if}
		<label
			><span class="sr-only">{uiText('Filter offline songs')}</span><input
				type="search"
				placeholder={uiText('Filter offline songs')}
				bind:value={filter}
			/></label
		>
		<ul>
			{#each matching as entry (entry.track.id)}
				<li>
					<button
						class="song"
						use:selectable={trackChoice(entry.track, entry.track.id)}
						onclick={() =>
							onplay(
								matching.map((i) => i.track),
								matching.indexOf(entry)
							)}
					>
						{#if selected !== null}<span class="check"
								>{selected.includes(entry.track.id) ? '✓' : '○'}</span
							>{:else}<Music2 size={20} />{/if}
						<span
							><strong>{entry.track.title}</strong><small
								>{[entry.track.artist, entry.track.album, storageSize(entry.bytes)]
									.filter(Boolean)
									.join(' · ')}</small
							></span
						></button
					>
					{#if !selected}<TrackActions
							{session}
							tracks={[entry.track]}
							label={'Options for ' + entry.track.title}
							localOnly
							vertical
						/>{#if !entry.pinned}<button
								class="icon-button"
								aria-label={'Keep ' + entry.track.title + ' offline'}
								disabled={busy}
								onclick={() =>
									run(async () => {
										const result = await saveOfflineTracks(session, [entry.track]);
										if (result.failed) throw Error(result.message);
										return result.message;
									})}><Download size={18} /></button
							>{/if}
						<button
							class="icon-button"
							aria-label={'Remove offline copy of ' + entry.track.title}
							disabled={busy}
							onclick={() => (remove = [entry.track.id])}><Trash2 size={17} /></button
						>{/if}
				</li>
			{:else}<li class="empty">
					{filter
						? uiText('No matching songs.')
						: view === 'downloaded'
							? uiText('Choose Save offline on a library song or selection to keep it here.')
							: view === 'automatic'
								? uiText(
										'Choose a download source in Offline settings to keep songs here automatically.'
									)
								: uiText('Enable caching in Offline settings to keep completed streams here.')}
				</li>{/each}
		</ul>
	{/if}
	{#if error}<p role="alert">{error}</p>
		<button class="text-button" onclick={read}>{uiText('Try again')}</button>{/if}
	{#if notice}<p role="status">{notice}</p>{/if}
</section>

<style>
	.song {
		user-select: none;
		-webkit-touch-callout: none;
	}
	.song:global([aria-pressed='true']) {
		background: var(--raised);
		color: var(--accent);
	}
	.bar,
	.actions,
	.confirm {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
		margin-block: 0.6rem;
	}
	.bar button {
		min-height: 44px;
		border-radius: var(--radius);
		border: 1px solid var(--line);
		padding: 0.4rem 0.75rem;
	}
	.bar [aria-pressed='true'] {
		background: var(--accent);
		color: var(--on-accent);
	}
	input {
		width: 100%;
	}
	ul {
		list-style: none;
		padding: 0;
	}
	li {
		display: flex;
		align-items: center;
		border-bottom: 1px solid var(--line);
		gap: 0.35rem;
	}
	.song {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		min-height: 58px;
		min-width: 0;
		flex: 1;
		text-align: start;
	}
	.song span {
		min-width: 0;
	}
	.song strong,
	.song small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	small,
	.empty {
		color: var(--muted);
	}
	.empty {
		padding-block: 0.75rem;
	}
	.check {
		font-size: 1.3rem;
	}
</style>
