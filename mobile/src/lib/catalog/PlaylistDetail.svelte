<script lang="ts">
	import { tr, uiText } from '../i18n';
	import WebDetail from './WebDetail.svelte';
	import { onMount } from 'svelte';
	import HomePinButton from './HomePinButton.svelte';
	import { ArrowLeft, Play, Shuffle, Trash2 } from '@lucide/svelte';
	import { DnError, type Session } from '../connection';
	import { errorMessage, type OnPlay } from './catalog';
	import {
		readPlaylist,
		playlistArtwork,
		renamePlaylist,
		movePlaylistEntry,
		removePlaylistEntry,
		deletePlaylist,
		type Playlist
	} from './playlists';
	import { entryStatus, importStatus, playlistRequests } from './playlistRequests.svelte';
	import { EllipsisVertical } from '@lucide/svelte';
	import { loadNearEnd } from './browseViewport';
	import { playlistShuffle } from './browseActions';
	import SelectionHost from './SelectionHost.svelte';
	import { trackChoice } from './librarySelection.svelte';
	import TrackRow from './TrackRow.svelte';
	import { detailInventory } from './detailInventory.svelte';
	import DetailAvailability from './DetailAvailability.svelte';
	import { matchesAvailability, type Availability } from '../offline/library';
	import { offlineSupported } from '../offline/media';
	import PlaylistHeading from './PlaylistHeading.svelte';
	import PlaylistDialog from './PlaylistDialog.svelte';
	import PlaylistExport from './PlaylistExport.svelte';
	import { Download } from '@lucide/svelte';
	import ReorderList from '../controls/ReorderList.svelte';
	import PlaylistNameForm from './PlaylistNameForm.svelte';
	import PlaylistSharing from './PlaylistSharing.svelte';
	let {
		session,
		playlist,
		onplay,
		onback,
		active = true,
		backLabel = 'Back to playlists'
	}: {
		session: Session;
		playlist: Playlist;
		onplay: OnPlay;
		onback: () => void;
		backLabel?: string;
		active?: boolean;
	} = $props();
	let detail = $state<Awaited<ReturnType<typeof readPlaylist>>>();
	let count = $state(50),
		editing = $state(false);
	let busy = $state(true),
		saving = $state(false),
		error = $state(''),
		editError = $state('');
	let exportStatus = $state('');
	let dialog = $state<'export' | 'rename' | 'sharing' | 'remove' | 'delete' | null>(null);
	let remove = $state<{ id: string; title: string } | null>(null);
	const current = $derived(detail?.playlist ?? playlist);
	const missingId = $derived(
		active &&
			(current.can_edit || current.is_owner) &&
			detail &&
			(current.source_ref?.startsWith('spotify:') ||
				detail.rows.some(({ entry, index }) => index === null && !entry.source_type))
			? current.id
			: undefined
	);
	const requests = playlistRequests(
		() => session,
		() => missingId,
		() => void load()
	);
	let requestEntry = $state<{ id: string; title: string }>();
	const selectedState = $derived(requestEntry && requests.entries.get(requestEntry.id));
	const device = detailInventory(
		() => session,
		() => active && !!detail
	);
	let availability = $state<Availability>('all');
	const filter = $derived(editing ? 'all' : availability);
	const visible = $derived.by(() => {
		const data = detail;
		let playIndex = 0;
		return (
			data?.rows.flatMap(({ entry, index }, position) => {
				const track = index === null ? undefined : data.tracks[index];
				if (
					filter !== 'all' &&
					!(track && device.inventory && matchesAvailability(device.inventory, track.id, filter))
				)
					return [];
				return [{ entry, position, track, playIndex: track ? playIndex++ : null }];
			}) ?? []
		);
	});
	const shownTracks = $derived(visible.flatMap(({ track }) => track ?? []));
	const shuffle = playlistShuffle();
	let playError = $state('');
	$effect(() => {
		void session;
		void active;
		void playlist;
		void filter;
		playError = '';
		return shuffle.cancel;
	});
	async function shufflePlaylist() {
		playError = '';
		try {
			await shuffle.play(shownTracks, session, onplay);
		} catch (cause) {
			playError = errorMessage(cause);
		}
	}
	const choicesInView = $derived(
		visible.flatMap(({ entry, track }) => (track ? [trackChoice(track, 'entry:' + entry.id)] : []))
	);
	const eligible = $derived(new Set(choicesInView.map((c) => c.id)));
	const countOnDevice = $derived(
		detail?.tracks.reduce((n, t) => n + Number(!!device.inventory?.byId.has(t.id)), 0) ?? 0
	);
	export function getPlaybackAvailability() {
		return filter === 'all' ? undefined : filter;
	}
	async function load() {
		busy = !detail;
		error = '';
		editError = '';
		try {
			detail = await readPlaylist(session, playlist);
			if (!detail.playlist.can_edit && !detail.playlist.can_delete) editing = false;
		} catch (e) {
			detail = undefined;
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}
	async function change(action: () => Promise<unknown>, deleted = false) {
		if (saving) return false;
		saving = true;
		editError = '';
		try {
			await action();
			window.dispatchEvent(new Event('dn-playlists-updated'));
			dialog = null;
			remove = null;
			if (deleted) onback();
			else await load();
			return !error;
		} catch (cause) {
			if (cause instanceof DnError && cause.status === 403) await load();
			editError = errorMessage(cause);
			return false;
		} finally {
			saving = false;
		}
	}
	async function moveEntry(from: number, to: number) {
		const entry = detail?.rows[from]?.entry;
		if (!entry || !editing || !current.can_edit) return false;
		return change(() => movePlaylistEntry(session, current.id, entry.id, to));
	}
	function close() {
		dialog = null;
		remove = null;
		editError = '';
	}
	onMount(() => {
		void load();
	});
</script>

<button class="text-button" onclick={onback}><ArrowLeft size={16} /> {uiText(backLabel)}</button>
<PlaylistHeading
	{session}
	id={'playlist:' + current.id}
	title={current.name}
	covers={playlistArtwork(current)}
	playlist={detail?.playlist}
	onchanged={load}
/>
{#if busy}<p role="status">{uiText('Loading tracks…')}</p>
{:else if error}<p role="alert">{error}</p>
	<button class="secondary" onclick={load}>{uiText('Try again')}</button>
{:else if detail}
	{#if detail.resolutionFailed}
		<p role="alert">{uiText('Could not check for newly added files.')}</p>
		<button class="secondary" onclick={load}>{uiText('Try again')}</button>
	{/if}
	<div class="actions">
		<HomePinButton {session} pin={{ kind: 'playlist', id: current.id, title: current.name }} />
		{#if detail.tracks.length}
			<button class="primary" disabled={!shownTracks.length} onclick={() => onplay(shownTracks, 0)}
				><Play size={18} />{uiText('Play playlist')}</button
			>
			<button class="secondary" disabled={!shownTracks.length} onclick={shufflePlaylist}
				><Shuffle size={18} />{uiText('Shuffle playlist')}</button
			>
		{/if}
		<button
			class="secondary"
			onclick={() => {
				exportStatus = '';
				dialog = 'export';
			}}><Download size={17} />{uiText('Export playlist')}</button
		>
		{#if current.can_edit || current.can_delete}
			<button
				class="secondary"
				disabled={saving}
				aria-pressed={editing}
				onclick={() => {
					editing = !editing;
					editError = '';
				}}>{editing ? uiText('Done editing') : uiText('Edit playlist')}</button
			>
		{/if}
	</div>
	{#if playError}<p role="alert">{playError}</p>{/if}
	{#if exportStatus}<p role="status">{exportStatus}</p>{/if}
	{#if editing}
		<div class="actions">
			{#if current.is_owner}
				<button class="text-button" disabled={saving} onclick={() => (dialog = 'rename')}
					>{uiText('Rename')}</button
				>
				<button class="text-button" disabled={saving} onclick={() => (dialog = 'sharing')}
					>{uiText('Share playlist')}</button
				>
			{/if}
			{#if current.can_delete}<button
					class="text-button"
					disabled={saving}
					onclick={() => (dialog = 'delete')}>{uiText('Delete playlist')}</button
				>{/if}
		</div>
	{/if}
	{#if editError && !dialog}<p role="alert">{editError}</p>{/if}
	{#if requests.state}
		{@const info = requests.state}
		{#if info.requestable_albums || info.no_album_songs || info.finding_albums || info.import}
			<div class="missing-summary">
				{#if info.requestable_albums}<button
						class="secondary"
						disabled={requests.sending}
						onclick={() => requests.album()}
						><Download size={17} />{tr(
							`Request missing albums (${info.requestable_albums})`,
							`不足しているアルバムをリクエスト（${info.requestable_albums}）`
						)}</button
					>{/if}
				{#if info.finding_albums}<small>{tr('Finding albums…', 'アルバムを検索中…')}</small>{/if}
				{#if info.no_album_songs}<small
						>{tr(
							`Songs with no album found: ${info.no_album_songs}`,
							`アルバム未特定の曲：${info.no_album_songs}`
						)}</small
					>{/if}
				{#if info.import}<small>{importStatus(info.import)}</small>{/if}
			</div>
		{/if}
	{/if}
	{#if requests.readingError}<p role="alert">{requests.readingError}</p>
		<button class="text-button" onclick={requests.refresh}>{uiText('Try again')}</button>{/if}
	{#if requests.receipt}<p role="status">{requests.receipt}</p>{/if}
	{#if requests.actionError}<p role="alert">{requests.actionError}</p>{/if}
	{#if offlineSupported && session.userId}<DetailAvailability
			source={device}
			available={countOnDevice}
			total={detail.tracks.length}
			unavailable={detail.rows.length - detail.tracks.length}
			{editing}
			value={availability}
			onchange={(v) => {
				availability = v;
				count = 50;
			}}
		/>{/if}
	{#if !visible.length && detail.tracks.length && device.inventory}<p>
			{uiText('No tracks match this availability.')}
		</p>{/if}
	{#if !detail.tracks.length}
		<p>
			{detail.rows.length
				? uiText('This playlist has no tracks available in your library.')
				: uiText('This playlist is empty.')}
		</p>
	{/if}
	<SelectionHost
		{session}
		{onplay}
		{active}
		enabled={!editing}
		scope={String(editing) + filter}
		choices={() => choicesInView}
		contains={(id) => eligible.has(id)}
	>
		<ReorderList
			count={detail.rows.length}
			order={() => JSON.stringify(detail?.rows.map(({ entry }) => entry.id))}
			move={moveEntry}
		>
			{#snippet children(grip)}
				{#if detail}
					<div data-part="track-list">
						{#each visible.slice(0, count) as { entry, position, track, playIndex } (entry.id)}
							{@const requestState = !track ? requests.entries.get(entry.id) : undefined}
							<div class="entry" data-entry={entry.id} data-reorder-row={position}>
								<TrackRow
									choice={track ? trackChoice(track, 'entry:' + entry.id) : undefined}
									availability={track && device.inventory
										? device.inventory.byId.has(track.id)
											? 'offline'
											: 'online'
										: undefined}
									title={entry.track_name}
									artist={entry.artist_name}
									duration={entry.duration}
									position={position + 1}
									onplay={playIndex === null ? undefined : () => onplay(shownTracks, playIndex)}
								/>
								{#if !editing && (requestState === 'requestable' || requestState === 'album_in_library')}
									<button
										class="icon-button"
										aria-label={tr(
											`Request options for ${entry.track_name}`,
											`${entry.track_name} のリクエストオプション`
										)}
										onclick={() => (requestEntry = { id: entry.id, title: entry.track_name })}
										><EllipsisVertical size={18} /></button
									>
								{/if}
								{#if editing && current.can_edit}
									<div class="tools">
										{@render grip(position, entry.track_name, saving)}
										<button
											class="icon-button"
											aria-label={'Remove ' + entry.track_name}
											disabled={saving}
											onclick={() => {
												remove = { id: entry.id, title: entry.track_name };
												dialog = 'remove';
												editError = '';
											}}><Trash2 size={17} /></button
										>
									</div>
								{/if}
								{#if requestState}<small class="request-status">{entryStatus(requestState)}</small
									>{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/snippet}
		</ReorderList>
		{#if count < visible.length}<button
				class="secondary more"
				data-selection-more={!editing || undefined}
				use:loadNearEnd={{ active, enabled: !editing, load: () => (count += 50) }}
				onclick={() => (count += 50)}>{uiText('More tracks')}</button
			>{/if}</SelectionHost
	>
{/if}
{#if requestEntry}
	<PlaylistDialog title={requestEntry.title} onclose={() => (requestEntry = undefined)}>
		<div class="actions">
			{#if selectedState === 'requestable'}<button
					class="secondary"
					disabled={requests.sending}
					onclick={() => {
						const id = requestEntry!.id;
						requestEntry = undefined;
						void requests.album(id);
					}}>{tr('Request album', 'アルバムをリクエスト')}</button
				>{/if}
			{#if selectedState === 'requestable' || selectedState === 'album_in_library'}<button
					class="secondary"
					disabled={requests.sending}
					onclick={() => {
						const id = requestEntry!.id;
						requestEntry = undefined;
						void requests.song(id);
					}}>{tr('Request just this song', 'この曲だけをリクエスト')}</button
				>{/if}
			<button class="text-button" onclick={() => (requestEntry = undefined)}
				>{uiText('Close')}</button
			>
		</div>
	</PlaylistDialog>
{/if}
{#if dialog === 'rename'}
	<PlaylistDialog title={uiText('Rename playlist')} onclose={close} busy={saving}>
		<PlaylistNameForm
			initial={current.name}
			action="Save name"
			bind:busy={saving}
			oncancel={close}
			onsubmit={async (name) => {
				await renamePlaylist(session, current.id, name);
				close();
				await load();
			}}
		/>
	</PlaylistDialog>
{:else if dialog === 'sharing'}
	<PlaylistSharing
		{session}
		playlist={current}
		onclose={close}
		onvisibility={(item) => {
			if (detail) detail.playlist = item;
		}}
	/>
{:else if dialog === 'remove' || dialog === 'delete'}
	<PlaylistDialog
		title={dialog === 'remove' ? 'Remove track?' : 'Delete playlist?'}
		onclose={close}
		busy={saving}
	>
		<p>
			{dialog === 'remove'
				? 'Remove “' + remove?.title + '” from “' + current.name + '”?'
				: 'Permanently delete “' + current.name + '” for everyone who uses it?'}
		</p>
		{#if editError}<p role="alert">{editError}</p>{/if}
		<div class="actions">
			<button class="secondary" disabled={saving} onclick={close}>{uiText('Cancel')}</button>
			{#if dialog === 'remove' && remove}
				<button
					class="primary"
					disabled={saving}
					onclick={() => {
						if (remove) {
							const id = remove.id;
							void change(() => removePlaylistEntry(session, current.id, id));
						}
					}}>{uiText('Remove track')}</button
				>
			{:else}
				<button
					class="primary"
					disabled={saving}
					onclick={() => change(() => deletePlaylist(session, current.id), true)}
					>{uiText('Delete playlist')}</button
				>
			{/if}
		</div>
	</PlaylistDialog>
{/if}

<WebDetail
	{session}
	route={'/playlists/' + encodeURIComponent(playlist.id)}
	label={uiText('Open playlist in web app')}
/>

{#if dialog === 'export'}<PlaylistExport
		{session}
		playlist={current}
		onclose={close}
		onsaved={(message) => {
			close();
			exportStatus = message;
		}}
	/>{/if}

<style>
	.actions,
	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.entry {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
	}
	.tools {
		flex-wrap: nowrap;
		gap: 0;
	}
	.request-status {
		grid-column: 1/-1;
		color: var(--muted);
		padding: 0.2rem 0 0.4rem 2.4rem;
	}
	.missing-summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--gap);
		margin-block: var(--gap);
	}
	.more {
		margin-top: var(--gap);
	}
</style>
