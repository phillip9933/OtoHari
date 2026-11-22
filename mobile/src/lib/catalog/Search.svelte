<script lang="ts">
	import { tr, uiText, uiFormat } from '../i18n';
	import { tick, untrack } from 'svelte';
	import type { Session } from '../connection';
	import { catalogSource } from './catalogSource.svelte';
	import { DeviceSearchIndex, deviceScopes } from './deviceSearch';
	import DeviceSearchResults from './DeviceSearchResults.svelte';
	import LibraryGroup from './LibraryGroup.svelte';
	import { albumItem, trackItem, type BrowseItem, type Category } from './libraryBrowse';
	import {
		readSearchDisplay,
		saveSearchDisplay,
		type CollectionDisplay
	} from './browsePreferences';
	import CollectionDisplayFields from './CollectionDisplayFields.svelte';
	import BrowseEntries from './BrowseEntries.svelte';
	import { artistArtwork } from './artistArtwork';
	import { ChevronLeft, SlidersHorizontal } from '@lucide/svelte';
	import { search, errorMessage, type Album, type OnPlay, type SearchScope } from './catalog';
	import type { Playlist } from './playlists';
	import SearchCollection from './SearchCollection.svelte';
	import SearchHints from './SearchHints.svelte';
	import RequestSong from './RequestSong.svelte';
	import { trackDuration } from './TrackRow.svelte';
	let {
		session,
		onopen,
		onplay,
		onartist,
		ongenre,
		onplaylist,
		active = true,
		term = $bindable('')
	}: {
		session: Session;
		onopen: (a: Album) => void;
		onplay: OnPlay;
		onartist: (a: { name: string; localId?: string | null; mbid?: string | null }) => void;
		ongenre: (name: string) => void;
		onplaylist: (p: Playlist) => void;
		term?: string;
		active?: boolean;
	} = $props();
	const scopes = [
		{ id: 'top', label: 'Top results' },
		{ id: 'artists', label: 'Artists' },
		{ id: 'albums', label: 'Albums' },
		{ id: 'tracks', label: 'Songs' },
		{ id: 'genres', label: 'Genres' },
		{ id: 'playlists', label: 'Playlists' }
	] as const;
	let scope = $state<SearchScope>('top'),
		offset = $state(0);
	let displayOpen = $state(false),
		displayIssue = $state('');
	const display = $derived(
		readSearchDisplay(session, scope, scope === 'top' ? undefined : deviceScopes[scope])
	);
	function changeDisplay(changes: Partial<CollectionDisplay>) {
		const saved = saveSearchDisplay(session, scope, { ...display, ...changes });
		displayIssue = saved
			? ''
			: tr(
					'Could not save the search display on this device.',
					'検索結果の表示設定をこの端末に保存できませんでした。'
				);
	}
	let result = $state<Awaited<ReturnType<typeof search>> | null>(null);
	const albumRows = $derived(result?.albums.map(albumItem) ?? []);
	const artistRows = $derived(
		result?.artists.map((a) => ({
			id: 'artist:' + (a.localId || a.mbid),
			title: a.name,
			subtitle: a.disambiguation || undefined,
			...artistArtwork(a.mbid, a.localId, a.artMissing)
		})) ?? []
	);
	const songRows = $derived(
		result?.tracks.map((track) => ({
			...trackItem(track),
			subtitle: [track.artist, track.album, track.duration ? trackDuration(track.duration) : '']
				.filter(Boolean)
				.join(' · ')
		})) ?? []
	);
	const recordingRows = $derived(
		result?.recordings.map(({ song, art }) => ({
			id: JSON.stringify([song.recording_mbid, song.release_mbid]),
			title: song.track_title,
			subtitle: [song.artist_name, song.album_title].filter(Boolean).join(' · '),
			art
		})) ?? []
	);
	let error = $state(''),
		busy = $state(false),
		retry = $state(0);
	let root: HTMLElement,
		localResults = $state<DeviceSearchResults>(),
		detail = $state.raw<{ category: Category; row: BrowseItem } | null>(null);
	let groupView = $state<LibraryGroup>();
	let hints = $state<SearchHints>(),
		editing = $state(false);
	function remember() {
		hints?.remember();
		editing = false;
	}
	const playResult: OnPlay = (...args) => {
		remember();
		return onplay(...args);
	};
	function pickHint(value: string, category: SearchScope) {
		hints?.remember(value, category);
		term = value;
		scope = category;
		changedQuery();
		editing = false;
	}
	const source = catalogSource(
		() => session,
		() => active,
		() => !!detail
	);
	const useDevice = $derived(source.useDevice),
		inventory = $derived(source.inventory);
	let ruleRevision = $state(0);
	const localModel = $derived.by(() => {
		void ruleRevision;
		return inventory ? new DeviceSearchIndex(session, inventory) : undefined;
	});
	let freshDetail = $state.raw<BrowseItem>(),
		detailError = $state('');
	let deviceLimit = $state(48);
	type Position = { scroll: number; depth?: number };
	const positions: Partial<Record<'device' | 'dn', Position>> = {};
	let previousMode: boolean | undefined,
		pendingPosition: Position | undefined,
		returnId = '',
		restoration = 0;
	const scopeLabel = $derived(uiText(scopes.find((s) => s.id === scope)!.label));
	const query = $derived({ account: session, q: term.trim(), kind: scope, start: offset, retry });
	let completed: typeof query | undefined;
	$effect(() => {
		const selected = detail,
			model = localModel;
		if (!selected) return;
		let live = true;
		detailError = '';
		if (!model) {
			freshDetail = undefined;
			return;
		}
		void model.find(selected.category, selected.row.id).then(
			(row) => {
				if (live) freshDetail = row;
			},
			(cause) => {
				if (live) detailError = errorMessage(cause);
			}
		);
		return () => {
			live = false;
		};
	});
	function deviceResultsTop(main: HTMLElement) {
		const results = root.querySelector('[data-part="device-search-results"]');
		return results && results.getBoundingClientRect().top - main.getBoundingClientRect().top;
	}
	function position(): Position {
		const main = root.closest('main');
		if (!main) return { scroll: 0 };
		const top = deviceResultsTop(main);
		return { scroll: main.scrollTop, depth: top !== null && top < 0 ? -top : undefined };
	}
	$effect.pre(() => {
		const local = useDevice;
		if (previousMode !== undefined && previousMode !== local && root && active && !detail) {
			const previous = position();
			positions[previousMode ? 'device' : 'dn'] = previous;
			pendingPosition = positions[local ? 'device' : 'dn'] ?? { scroll: previous.scroll };
		}
		previousMode = local;
	});
	function restore() {
		if (!pendingPosition || detail || !active) return;
		const generation = ++restoration;
		void tick().then(() =>
			requestAnimationFrame(() => {
				if (generation !== restoration || !pendingPosition || detail || !active) return;
				const main = root.closest('main');
				if (main) {
					// Suggestions can close above the results while an album detail is open.
					const top = deviceResultsTop(main);
					main.scrollTo(
						0,
						pendingPosition.depth !== undefined && top !== null
							? main.scrollTop + top + pendingPosition.depth
							: pendingPosition.scroll
					);
				}
				pendingPosition = undefined;
				if (useDevice && returnId) {
					const id = returnId;
					void tick().then(() => requestAnimationFrame(() => localResults?.focusResult(id)));
				}
				returnId = '';
			})
		);
	}
	function changedQuery() {
		offset = 0;
		deviceLimit = 48;
		pendingPosition = undefined;
		returnId = '';
		delete positions.device;
		delete positions.dn;
	}
	function choose(next: SearchScope) {
		if (next !== scope) {
			scope = next;
			changedQuery();
		}
	}
	export function getPlaybackAvailability() {
		if (groupView) return groupView.getPlaybackAvailability();
		return useDevice || detail ? 'offline' : undefined;
	}
	function enterDevice(category: Category, row: BrowseItem) {
		positions.device = position();
		remember();
		freshDetail = row;
		detail = { category, row };
		void tick().then(() => {
			const main = root.closest('main');
			main?.scrollTo(0, 0);
			main?.focus({ preventScroll: true });
		});
	}
	export function goBack() {
		if (!detail) return false;
		pendingPosition = positions[useDevice ? 'device' : 'dn'] ?? { scroll: 0 };
		returnId = detail.row.id;
		detail = null;
		freshDetail = undefined;
		void tick().then(() => {
			if (!useDevice && completed === query) restore();
		});
		return true;
	}
	$effect(() => {
		const spec = query,
			can = active && source.ready && !detail;
		if (useDevice) {
			completed = undefined;
			return;
		}
		if (!can) return;
		const { account, q, kind, start } = spec;
		if (completed === spec) {
			untrack(restore);
			return;
		}
		result = null;
		error = '';
		const searchable = q.length >= 2 && kind !== 'genres' && kind !== 'playlists';
		busy = searchable;
		if (!searchable) {
			if (kind !== 'genres' && kind !== 'playlists') untrack(restore);
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const found = await search(
					account,
					q,
					kind as 'top' | 'albums' | 'artists' | 'tracks',
					start,
					controller.signal
				);
				if (!controller.signal.aborted) {
					result = found;
					completed = spec;
				}
			} catch (cause) {
				if (!controller.signal.aborted && !source.connectionFailed(cause))
					error = errorMessage(cause);
			} finally {
				if (!controller.signal.aborted) {
					busy = false;
					if (!useDevice) restore();
				}
			}
		}, 300);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});
</script>

<div bind:this={root}>
	<div hidden={!!detail}>
		<div class="search-header">
			<h1>{uiText('Search')}</h1>
			<button
				class="text-button display-button"
				aria-label={tr('Search display', '検索結果の表示設定')}
				aria-expanded={displayOpen}
				onclick={() => {
					displayOpen = !displayOpen;
					displayIssue = '';
				}}><SlidersHorizontal size={20} /></button
			>
		</div>
		<input
			type="search"
			bind:value={term}
			oninput={() => {
				changedQuery();
				editing = true;
			}}
			onfocus={() => (editing = true)}
			onkeydown={(event) => {
				if (event.key === 'Enter' && !event.isComposing) {
					remember();
					event.currentTarget.blur();
				}
			}}
			enterkeyhint="search"
			aria-label={uiText('Search music')}
			placeholder={scope === 'top'
				? uiText('Search music')
				: uiFormat('Search {name}', { name: scopeLabel.toLocaleLowerCase('en') })}
			autocomplete="off"
		/>
		<div class="scopes" role="group" aria-label={uiText('Search category')}>
			{#each scopes as item (item.id)}<button
					aria-pressed={scope === item.id}
					onclick={() => choose(item.id)}>{uiText(item.label)}</button
				>{/each}
		</div>
		{#if displayOpen}<section
				class="display-options"
				aria-label={tr('Result display', '検索結果の表示')}
			>
				<h2>{scopeLabel}</h2>
				<CollectionDisplayFields settings={display} onchange={changeDisplay} />
				{#if displayIssue}<p role="alert">{displayIssue}</p>{/if}
			</section>{/if}
		<SearchHints
			bind:this={hints}
			{session}
			{term}
			{scope}
			{editing}
			active={active && source.ready && !detail}
			offline={useDevice}
			model={localModel}
			onpick={pickHint}
		/>
		{#if source.policyIssue}<p role="alert">{source.policyIssue}</p>
			<button class="secondary" onclick={() => source.retryPolicy()}
				>{uiText('Retry search settings')}</button
			>
		{:else if !source.ready}<p role="status">{uiText('Opening search…')}</p>
		{:else if useDevice}
			<p class="device-source" role="status">
				{source.unreachable
					? uiText('DN is unavailable. Searching music on this device.')
					: uiText('Searching music on this device.')}
				{#if source.unreachable}<button
						class="text-button"
						onclick={() => {
							source.retryNetwork();
							retry++;
						}}>{uiText('Retry DN')}</button
					>{/if}
			</p>
			{#if source.storageError}<p role="alert">{source.storageError}</p>
				{#if session.userId}<button class="secondary" onclick={() => source.retryStorage()}
						>{uiText('Retry device library')}</button
					>{/if}
			{:else if inventory && !inventory.items.length}<p>
					{uiText('No music is saved or cached for this account on this device.')}
				</p>
			{:else if inventory && localModel}<DeviceSearchResults
					bind:this={localResults}
					bind:limit={deviceLimit}
					{session}
					{inventory}
					model={localModel}
					{display}
					{term}
					{scope}
					active={active && !detail}
					{choose}
					onopen={enterDevice}
					onplay={playResult}
					onready={restore}
					onrules={() => ruleRevision++}
				/>
			{:else if source.storageBusy}<p role="status">{uiText('Opening saved music…')}</p>{/if}
		{:else if scope === 'genres' || scope === 'playlists'}
			<SearchCollection
				{display}
				{session}
				{scope}
				{term}
				ongenre={(value) => {
					remember();
					ongenre(value);
				}}
				onplaylist={(value) => {
					remember();
					onplaylist(value);
				}}
				active={active && !detail}
				onerror={source.connectionFailed}
				onready={restore}
			/>
		{:else if error}<p role="alert">{error}</p>
			<button class="secondary" onclick={() => retry++}>{uiText('Try again')}</button>
		{:else if busy}<p role="status">{uiText('Searching…')}</p>
		{:else if result}
			{#if songRows.length}<h2>{uiText('Songs in your library')}</h2>
				<BrowseEntries
					{session}
					{...display}
					category="Tracks"
					items={songRows}
					open={(_, idx) => {
						if (result) void playResult(result.tracks, idx);
					}}
				/>{/if}
			{#if artistRows.length}<h2>{uiText('Artists')}</h2>
				<BrowseEntries
					{session}
					{...display}
					category="Artists"
					items={artistRows}
					open={(_, idx) => {
						if (result) {
							remember();
							onartist(result.artists[idx]);
						}
					}}
				/>{/if}
			{#if albumRows.length}<h2>{uiText('Albums')}</h2>
				<BrowseEntries
					{session}
					{...display}
					category="Albums"
					albumGallery
					items={albumRows}
					open={(item) => {
						if (item.album) {
							remember();
							onopen(item.album);
						}
					}}
				/>{/if}
			{#if recordingRows.length}<h2>{uiText('Songs to request')}</h2>
				<BrowseEntries
					{session}
					{...display}
					category="Tracks"
					label={uiText('Songs to request')}
					items={recordingRows}
				>
					{#snippet endAction(idx: number)}{#if result}{@const row =
								result.recordings[idx]}<RequestSong
								{session}
								song={row.song}
								requested={row.requested}
							/>{/if}{/snippet}
				</BrowseEntries>{/if}
			{#if result.partial}<p role="status">{uiText('Some MusicBrainz results are unavailable.')}</p>
				<button class="secondary" onclick={() => retry++}>{uiText('Retry search')}</button>{/if}
			{#if !result.albums.length && !result.tracks.length && !result.artists.length && !result.recordings.length}<p
				>
					{offset ? uiText('No more matches.') : 'No matches for “' + term.trim() + '”.'}
				</p>{/if}
			{#if scope !== 'top' && (offset > 0 || result.next !== null)}
				<div class="pages">
					<button
						class="secondary"
						disabled={!offset}
						onclick={() => {
							if (result) offset = result.previous;
						}}>{uiText('Previous results')}</button
					><button
						class="secondary"
						disabled={result.next === null}
						onclick={() => {
							if (result?.next != null) offset = result.next;
						}}>{uiText('Next results')}</button
					>
				</div>
			{/if}
		{:else if term.length}<p>{uiText('Enter at least two characters.')}</p>{/if}
	</div>
	{#if detail}
		{#if (detail.category !== 'Albums' && detail.category !== 'Artists') || detailError}<button
				class="text-button device-back"
				aria-label={uiText('Back to search')}
				onclick={goBack}><ChevronLeft size={18} />{uiText('Back to search')}</button
			>{/if}
		{#if detailError}<p role="alert">{detailError}</p>
			<button class="secondary" onclick={() => source.retryStorage()}
				>{uiText('Retry device library')}</button
			>
		{:else}
			{#key detail.row.id}<LibraryGroup
					bind:this={groupView}
					onback={goBack}
					backLabel={uiText('Back to search')}
					{source}
					{session}
					{active}
					offline
					item={freshDetail ?? detail.row}
					tracks={freshDetail?.localTracks ?? []}
					{onplay}
				/>{/key}
		{/if}
	{/if}
</div>

<style>
	.device-source,
	.device-back {
		display: flex;
		gap: 0.45rem;
		align-items: center;
	}
	.device-source {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.device-source button,
	.device-back {
		min-height: 44px;
	}
	.scopes,
	.pages {
		gap: 0.35rem;
		margin: 0.5rem 0 1rem;
	}
	.scopes {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 6.5rem), 1fr));
	}
	.pages {
		display: flex;
		flex-wrap: wrap;
	}
	.scopes button {
		min-height: 44px;
		padding: 0.3rem 0.45rem;
		overflow-wrap: anywhere;
		font-weight: 600;
		font-size: 0.92rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.scopes button[aria-pressed='true'] {
		color: var(--on-accent);
		background: var(--accent);
		border-color: var(--accent);
	}

	.search-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.display-button {
		min-width: 44px;
		min-height: 44px;
		display: grid;
		place-items: center;
	}
	.display-options {
		margin: 0 0 0.8rem;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr));
		align-items: end;
		gap: 0.45rem 0.8rem;
	}
	.display-options h2,
	.display-options p {
		grid-column: 1/-1;
		margin: 0.15rem 0;
		font-size: 0.95rem;
	}
</style>
