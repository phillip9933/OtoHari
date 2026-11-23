<script lang="ts">
	import { tr, uiText } from '../i18n';
	import { onMount, onDestroy } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Play, Shuffle } from '@lucide/svelte';
	import type { Session } from '../connection';
	import type { PlayerTrack } from '../player';
	import { errorMessage, type OnPlay } from './catalog';
	import { offlineSupported } from '../offline/media';
	import { availableTracks, matchesAvailability, type Availability } from '../offline/library';
	import { detailInventory, type DetailInventory } from './detailInventory.svelte';
	import DetailAvailability from './DetailAvailability.svelte';
	import { albumTrackCount, type AlbumCount } from './albumTrackCounts';
	import PlaylistHeading from './PlaylistHeading.svelte';
	import { offlinePlaylists } from './playlistOffline';
	import { smartPlaylistTracks } from './smartPlaylists';
	import { deviceTrackOrder, matchesDeviceTrack } from './trackFilters';
	import {
		browseChoice,
		localAlbumKey,
		type BrowseItem,
		type DeviceCollection,
		trackOccurrences
	} from './libraryBrowse';
	import { loadNearEnd } from './browseViewport';
	import { tappedPlayback, type PageEnd } from './browsePlayback';
	import { untrack } from 'svelte';
	import { beginPlaybackPreparation, shuffled } from './browseActions';
	import { queueSizeCheck } from './libraryQueue';
	import { genreTracksPage, tracksInGenre } from './libraryGenres';
	import { prepareLibraryPlayback } from '../player/libraryWindow';
	import AlbumHero from './AlbumHero.svelte';
	import ArtistHeader from './ArtistHeader.svelte';
	import { browsePin } from './homePins';
	import HomePinButton from './HomePinButton.svelte';
	import TrackActions from './TrackActions.svelte';
	import SelectionHost from './SelectionHost.svelte';
	import BrowseEntries from './BrowseEntries.svelte';

	let {
		session,
		item,
		tracks,
		offline,
		source,
		collection,
		initialAvailability = 'all',
		backLabel,
		onback,
		onplay,
		active
	}: {
		session: Session;
		item: BrowseItem;
		tracks: PlayerTrack[];
		offline: boolean;
		source?: DetailInventory;
		collection?: DeviceCollection;
		initialAvailability?: Availability;
		backLabel?: string;
		onback?: () => void;
		onplay: OnPlay;
		active: boolean;
	} = $props();
	let limit = $state(48),
		error = $state(''),
		busy = $state(false);
	let results = $state<BrowseEntries>(),
		returnItem = '',
		inBackground = false,
		shownDocument = $state(!document.hidden);
	const pages: PageEnd[] = [];
	const remoteGenre = $derived(item.genre !== undefined && !item.localTracks);
	let serverTracks = $state.raw<PlayerTrack[]>([]),
		cursor = $state<string | null>(null),
		knownTotal = $state<number>(),
		reading = $state(false),
		pageError = $state(''),
		pageRead: AbortController | undefined,
		queueRead = $state<AbortController>();
	const ownSource = detailInventory(
		() => session,
		() => !source && active
	);
	const device = $derived(source ?? ownSource);
	const inventory = $derived(device.inventory);
	const isAlbum = $derived(item.id.startsWith('Albums:'));
	const isPlaylist = $derived(item.id.startsWith('playlist:') || !!item.smart);
	const showAvailability = $derived(
		offlineSupported && !!session.userId && (isAlbum || isPlaylist)
	);
	const deviceOnly = $derived(!!collection || offline || !!item.localTracks);
	let availability = $state<Availability>(untrack(() => initialAvailability));
	const filter = $derived(availability === 'all' && deviceOnly ? 'offline' : availability);
	export function getPlaybackAvailability() {
		return filter === 'all' ? undefined : filter;
	}
	let smartTracks = $state.raw<PlayerTrack[]>(),
		smartError = $state(''),
		smartRevision = $state(0);
	$effect(() => {
		const data = inventory,
			rule = item.smart,
			owner = session;
		void smartRevision;
		if (!collection || !rule || !data || !active) return;
		const job = new AbortController();
		smartError = '';
		void smartPlaylistTracks(owner, rule, job.signal, availableTracks(data)).then(
			(result) => {
				if (!job.signal.aborted) smartTracks = result;
			},
			(cause) => {
				if (!job.signal.aborted) smartError = errorMessage(cause);
			}
		);
		return () => job.abort();
	});
	const savedAlbum = $derived(
		isAlbum && inventory && deviceOnly
			? availableTracks(inventory).filter((t) => 'Albums:' + localAlbumKey(t) === item.id)
			: undefined
	);
	const candidates = $derived.by(() => {
		if (!deviceOnly) return tracks;
		if (!inventory) return [];
		if (collection?.category === 'Albums') {
			const filters = { ...collection.filters, q: '' };
			return (savedAlbum ?? [])
				.filter((t) => matchesDeviceTrack(t, filters))
				.sort(deviceTrackOrder({ sort: 'album', order: 'asc' }));
		}
		if (collection?.category === 'Playlists') {
			if (item.smart) return smartTracks ?? [];
			return offlinePlaylists(session, availableTracks(inventory), item.id)[0]?.localTracks ?? [];
		}
		return tracks.flatMap((t) => inventory?.byId.get(t.id)?.track ?? []);
	});
	const deviceArtist = $derived(
		item.id.startsWith('Artists:') && onback
			? {
					pin: browsePin(item, 'Artists'),
					art: item.art
				}
			: undefined
	);
	const albumHeader = $derived(
		isAlbum && onback
			? {
					title: item.title,
					artist: candidates[0]?.albumArtist || candidates[0]?.artist || item.album?.artist || '',
					art: item.art || candidates[0]?.artworkUrl,
					year: item.year ?? item.album?.year
				}
			: undefined
	);
	const albumShortcut = $derived(isAlbum ? browsePin(item, 'Albums') : undefined);
	const countOnDevice = $derived(
		savedAlbum?.length ?? candidates.reduce((n, t) => n + Number(!!inventory?.byId.has(t.id)), 0)
	);
	const observedAlbumId = $derived(deviceOnly && isAlbum ? savedAlbum?.[0]?.albumId : undefined);
	let loadedCount = $state.raw<{ owner: Session; id: string; count: AlbumCount }>();
	const observation = $derived(
		loadedCount?.owner === session && loadedCount.id === observedAlbumId
			? loadedCount.count
			: undefined
	);
	$effect(() => {
		const id = observedAlbumId,
			owner = session;
		if (!id) return;
		let active = true;
		void albumTrackCount(owner, id).then((result) => {
			if (active) loadedCount = result ? { owner, id, count: result } : undefined;
		});
		return () => {
			active = false;
		};
	});
	const knownPlayable = $derived(
		!deviceOnly ? candidates.length : (item.knownPlayable ?? observation?.total)
	);
	const filteredTracks = $derived(
		!showAvailability || filter === 'all'
			? candidates
			: candidates.filter((t) => inventory && matchesAvailability(inventory, t.id, filter))
	);
	const shown = $derived(remoteGenre ? serverTracks : filteredTracks.slice(0, limit));
	const total = $derived(
		remoteGenre ? (knownTotal ?? item.count ?? serverTracks.length) : filteredTracks.length
	);
	const seenCursors = new SvelteSet<string>();
	async function readPage(more = false) {
		if (reading || item.genre === undefined) return;
		const job = new AbortController();
		pageRead = job;
		reading = true;
		pageError = '';
		try {
			const p = await genreTracksPage(session, item.genre, more ? cursor : null, job.signal);
			job.signal.throwIfAborted();
			if (p.next && seenCursors.has(p.next))
				throw Error('The library changed while loading. Try again.');
			if (p.next) seenCursors.add(p.next);
			const ids = new Set(serverTracks.map((t) => t.id));
			serverTracks = more ? [...serverTracks, ...p.tracks.filter((t) => !ids.has(t.id))] : p.tracks;
			knownTotal = p.total;
			cursor = p.next;
			pages.push({ end: serverTracks.length, after: cursor });
		} catch (cause) {
			if (!job.signal.aborted) pageError = errorMessage(cause);
		} finally {
			if (!job.signal.aborted) reading = false;
		}
	}
	async function all(shuffle: boolean) {
		if (busy) return;
		const job = new AbortController();
		queueRead = job;
		busy = true;
		error = '';
		const finish = beginPlaybackPreparation(() => job.abort());
		try {
			if (remoteGenre && item.genre) {
				const batch = await prepareLibraryPlayback(
					session,
					{ genre: item.genre, sort: shuffle ? 'random' : 'album', order: 'asc' },
					job.signal
				);
				job.signal.throwIfAborted();
				finish();
				await onplay(batch.tracks, 0, batch.continuation);
				return;
			}
			const selection = remoteGenre
				? await tracksInGenre(session, item.genre!, job.signal, true)
				: filteredTracks;
			job.signal.throwIfAborted();
			const check = queueSizeCheck(session.serverUrl);
			selection.forEach(check);
			const order = shuffle ? await shuffled(selection, session) : selection;
			job.signal.throwIfAborted();
			finish();
			await onplay(order, 0);
		} catch (cause) {
			if (!job.signal.aborted) error = errorMessage(cause);
		} finally {
			finish();
			if (queueRead === job) {
				queueRead = undefined;
				busy = false;
			}
		}
	}
	onDestroy(() => {
		pageRead?.abort();
		queueRead?.abort();
	});
	// Offline playlists can contain the same recording twice. Each occurrence has its own action.
	const rows = $derived(trackOccurrences(shown));
	const eligible = $derived(new Set(rows.map((r) => r.id)));
	onMount(() => {
		const visibility = () => (shownDocument = !document.hidden);
		document.addEventListener('visibilitychange', visibility);
		return () => document.removeEventListener('visibilitychange', visibility);
	});
	$effect(() => {
		const foreground = active && shownDocument;
		untrack(() => {
			if (!foreground) {
				inBackground = true;
				pageRead?.abort();
				queueRead?.abort();
				reading = false;
				return;
			}
			if (remoteGenre && !serverTracks.length && !pages.length && !pageError && !reading)
				void readPage();
			if (inBackground && returnItem) {
				const id = returnItem;
				returnItem = '';
				requestAnimationFrame(() => {
					if (active && shownDocument) void results?.focusItem(id);
				});
			}
			inBackground = false;
		});
	});
	async function play(row: BrowseItem) {
		if (busy) return;
		busy = true;
		error = '';
		returnItem = row.id;
		try {
			const source = remoteGenre ? shown : filteredTracks,
				index = rows.findIndex((i) => i.id === row.id);
			const batch = tappedPlayback(
				session.serverUrl,
				source,
				index,
				pages,
				total,
				remoteGenre && item.genre ? { genre: item.genre, sort: 'album', order: 'asc' } : undefined
			);
			await onplay(batch.tracks, batch.index, batch.continuation);
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			busy = false;
		}
	}
</script>

{#snippet contents()}
	<SelectionHost
		choices={() => rows.map((i) => browseChoice(session, i))}
		contains={(id) => eligible.has(id)}
		{session}
		{onplay}
		{active}
		localOnly={offline}
		heading={albumHeader || deviceArtist || isPlaylist ? undefined : item.title}
		scope={JSON.stringify([item.id, filter])}
	>
		{#if isPlaylist}<PlaylistHeading
				{session}
				id={item.id}
				title={item.title}
				covers={item.covers}
				cacheOnly={deviceOnly}
				playlist={deviceOnly ? undefined : item.playlist}
			/>{/if}
		{#if item.smart}<small>{uiText('Smart playlist · on this device')}</small>{/if}
		{#if showAvailability}<DetailAvailability
				source={device}
				available={countOnDevice}
				total={knownPlayable}
				observedAt={item.knownPlayable === undefined ? observation?.seenAt : undefined}
				{deviceOnly}
				value={filter}
				onchange={(v) => {
					availability = v;
					limit = 48;
				}}
			/>
		{:else}<p>{total.toLocaleString()} {total === 1 ? uiText('track') : uiText('tracks')}</p>{/if}
		{#if shown.length}
			{#if !albumHeader && !deviceArtist}<div class="group-actions">
					<button class="primary" disabled={busy} onclick={() => all(false)}
						><Play size={17} />{uiText('Play all')}</button
					><button class="secondary" disabled={busy} onclick={() => all(true)}
						><Shuffle size={17} />{uiText('Shuffle all')}</button
					>
				</div>{/if}
			<BrowseEntries
				bind:this={results}
				{active}
				{total}
				{session}
				items={rows}
				category="Tracks"
				numbered={!!albumHeader}
				layout="list"
				columns={1}
				{inventory}
				cacheOnly={deviceOnly}
				showOnlineOnly={showAvailability}
				localOnly={offline}
				open={play}
			/>
			{#if remoteGenre && cursor}<button
					class="secondary"
					disabled={reading}
					data-selection-more={!pageError || undefined}
					use:loadNearEnd={{ active, enabled: !reading && !pageError, load: () => readPage(true) }}
					onclick={() => readPage(true)}>{uiText('More songs')}</button
				>{:else if !remoteGenre && limit < filteredTracks.length}<button
					class="secondary"
					data-selection-more
					use:loadNearEnd={{ active, enabled: true, load: () => (limit += 48) }}
					onclick={() => (limit += 48)}>{uiText('More songs')}</button
				>{/if}
		{:else if !reading && !pageError}<p>{uiText('No matching tracks.')}</p>{/if}
		{#if smartError}<p role="alert">{smartError}</p>
			<button class="secondary" onclick={() => smartRevision++}
				>{uiText('Retry smart playlist')}</button
			>{/if}
		{#if pageError}<p role="alert">{pageError}</p>
			<button class="secondary" onclick={() => readPage(!!serverTracks.length)}
				>{uiText('Retry')}</button
			>{/if}
		{#if reading}<p role="status">{uiText('Loading genre tracks…')}</p>{/if}
		{#if queueRead && busy}<button class="text-button" onclick={() => queueRead?.abort()}
				>{uiText('Cancel preparation')}</button
			>{/if}
		{#if error}<p role="alert">{error}</p>{/if}
	</SelectionHost>
{/snippet}

{#if albumHeader && onback}
	<AlbumHero
		{session}
		album={albumHeader}
		tracks={candidates}
		{onback}
		{backLabel}
		cacheOnly={deviceOnly}
	>
		{#snippet actions()}
			{#snippet albumExtras(close: () => void)}
				<HomePinButton
					{session}
					pin={albumShortcut}
					compact
					ondone={close}
					labels={{
						add: tr('Pin album to Home', 'アルバムをホームにピン留め'),
						remove: tr('Unpin album from Home', 'ホームからアルバムを外す')
					}}
				/>
			{/snippet}
			{#if filteredTracks.length || albumShortcut}<TrackActions
					collection={albumExtras}
					{session}
					tracks={filteredTracks}
					localOnly={deviceOnly}
					vertical
					label={tr('More album actions', 'アルバムのその他の操作')}
				/>{/if}
			<button
				class="icon-button"
				aria-label={uiText('Shuffle all')}
				disabled={!total || busy}
				onclick={() => all(true)}><Shuffle size={20} /></button
			>
			<button
				class="primary"
				aria-label={uiText('Play all')}
				disabled={!total || busy}
				onclick={() => all(false)}><Play size={19} />{uiText('Play')}</button
			>
		{/snippet}
		{@render contents()}
	</AlbumHero>
{:else if deviceArtist && onback}
	<ArtistHeader
		{session}
		name={item.title}
		device={deviceArtist}
		{onback}
		backLabel={backLabel ?? 'Back'}
		{onplay}
	>
		{#snippet actions()}
			<button
				class="primary"
				aria-label={uiText('Play all')}
				disabled={!total || busy}
				onclick={() => all(false)}><Play size={17} />{uiText('Play')}</button
			>
			<button
				class="icon-button"
				aria-label={uiText('Shuffle all')}
				disabled={!total || busy}
				onclick={() => all(true)}><Shuffle size={19} /></button
			>
		{/snippet}
	</ArtistHeader>
	{@render contents()}
{:else}
	{@render contents()}
{/if}

<style>
	.group-actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
		margin-bottom: 0.8rem;
	}
	.group-actions button {
		min-height: 44px;
	}
</style>
