<script lang="ts">
	import { tr, uiText } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import CollectionDisplayFields from './CollectionDisplayFields.svelte';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		ArrowDown,
		EllipsisVertical,
		ArrowDownUp,
		ArrowUp,
		ChevronLeft,
		Disc3,
		Filter,
		Grid2X2,
		List,
		ListEnd,
		ListMusic,
		ListStart,
		Music2,
		Play,
		Plus,
		Search,
		Shuffle,
		Tags,
		UsersRound,
		X
	} from '@lucide/svelte';
	import type { Session } from '../connection';
	import { player, placementMessage, type PlayerTrack } from '../player';
	import type { Album, OnPlay } from './catalog';
	import { errorMessage } from './catalog';
	import type { Playlist } from './playlists';
	import { offlineSupported, saveOfflineTracks } from '../offline/media';
	import { detailInventory } from './detailInventory.svelte';
	import { availableTracks, type Availability } from '../offline/library';
	import { accountId, loadLayout, saveLayout } from '../boards/layout';
	import {
		libraryFilter,
		type LibraryFilter,
		type FilterSection
	} from '../boards/filteredSections';
	import FilterSectionDialog from '../boards/FilterSectionDialog.svelte';
	import {
		browsePage,
		orderChoices,
		resolveItem,
		type BrowseFilters,
		type DeviceCollection,
		type BrowseItem,
		type Category
	} from './libraryBrowse';
	import {
		readBrowsePreferences,
		saveBrowsePreferences,
		type BrowsePreferences
	} from './browsePreferences';
	import {
		beginPlaybackPreparation,
		collectionTracks,
		playbackFilter,
		shuffled
	} from './browseActions';
	import { prepareLibraryPlayback } from '../player/libraryWindow';
	import { queueSizeCheck } from './libraryQueue';
	import type { SmartPlaylist } from './smartPlaylists';
	import SelectionHost from './SelectionHost.svelte';
	import BrowseEntries from './BrowseEntries.svelte';
	import AlphabetRail from './AlphabetRail.svelte';
	import {
		launcherShortcuts,
		pendingShortcut,
		pinPlaylist,
		playlistShortcutReceipt
	} from './launcherShortcuts';
	import { foldSearchText } from './trackFilters';
	import BrowseItemMenu from './BrowseItemMenu.svelte';
	import { loadNearEnd } from './browseViewport';
	import { tappedPlayback, type PageEnd } from './browsePlayback';
	import { browseChoice, requestFilters, type BrowseSnapshot } from './libraryBrowse';
	import LibraryFilters from './LibraryFilters.svelte';
	import PlaylistEditor from './PlaylistEditor.svelte';
	import PlaylistImport from './PlaylistImport.svelte';
	import AddToPlaylist from './AddToPlaylist.svelte';

	let {
		session,
		category,
		availability,
		chooseAvailability,
		observeDevice,
		active,
		onopen,
		onlocal,
		onplaylist,
		onplay,
		ondetail,
		onback
	}: {
		session: Session;
		category: Category;
		availability: Availability;
		chooseAvailability: (value: Availability) => void;
		observeDevice: boolean;
		active: boolean;
		onopen: (album: Album) => void;
		onlocal: (artist: { id: string; name: string }) => void;
		onplaylist: (p: Playlist) => void;
		onplay: OnPlay;
		ondetail: (
			row: BrowseItem,
			tracks: PlayerTrack[],
			offline: boolean,
			collection?: DeviceCollection
		) => void;
		onback: () => void;
	} = $props();
	const icons = {
		Playlists: ListMusic,
		Artists: UsersRound,
		Albums: Disc3,
		Tracks: Music2,
		Genres: Tags
	};
	const Icon = $derived(icons[category]);
	const kind = $derived(
		category === 'Tracks' ? 'songs' : category === 'Albums' ? 'albums' : 'artists'
	);
	const unit = $derived(category === 'Tracks' ? 'songs' : category.toLowerCase());
	const searchLabel = $derived(tr('Search ' + category.toLowerCase(), uiText(category) + 'を検索'));
	let settings = $derived(readBrowsePreferences(session, category));
	let filters = $state<BrowseFilters>(
		untrack(() => ({
			q: '',
			favorites: false,
			rating: 0,
			ratingMode: 'at_least',
			formats: [],
			formatMode: 'with',
			sort: settings.sort,
			order: settings.order
		}))
	);
	let connected = $state(navigator.onLine);
	const device = detailInventory(
		() => session,
		() => observeDevice
	);
	const inventory = $derived(device.inventory);
	const ready = $derived(
		!offlineSupported || !session.userId || !!inventory || !!device.storageError
	);
	export function getDeviceSource() {
		return device;
	}
	const disconnected = $derived(!connected || inventory?.offlineOnly === true);
	const availableScope = $derived([availability, disconnected].join('|'));
	const available = $derived(
		disconnected || availability !== 'all'
			? inventory
				? availableTracks(inventory, availability)
				: []
			: undefined
	);
	const localFormats = $derived([
		...new Set(available?.flatMap((t) => (t.format ? [t.format.toLowerCase()] : [])) ?? [])
	]);
	const sortLabel = $derived(
		orderChoices[category].find(([s]) => s === filters.sort)?.[1] ?? 'Name'
	);
	let panel = $state<'' | 'sort' | 'search' | 'filters' | 'display'>(''),
		searchBox = $state<HTMLInputElement>(),
		typed = $state('');
	let host = $state<SelectionHost>(),
		items = $state.raw<BrowseItem[]>([]),
		total = $state<number>(),
		cursor = $state<string | null>(null),
		loading = $state(true),
		waitingMore = $state(false),
		error = $state(''),
		retry = $state(0),
		scan = $state('');
	let receipt = $state(''),
		actionError = $state(''),
		progress = $state(''),
		busy = $state(false);
	let pageRequest: AbortController | undefined, actionRequest: AbortController | undefined;
	let results: BrowseEntries;
	let jumpNotice = $state(''),
		jumpGeneration = 0;
	let pendingPage: { signal: AbortSignal; promise: Promise<void> } | undefined;
	let returnItem = '',
		preserveLength = 0,
		wasActive = false,
		visible = $state(!document.hidden);
	let snapshot: BrowseSnapshot = {},
		pages: PageEnd[] = [],
		cursors = new SvelteSet<string>();
	const known = $derived(new Set(items.map((i) => i.id)));
	const changeKey = $derived({
		f: { ...filters, formats: [...filters.formats] },
		c: category,
		a: session,
		m: available,
		retry
	});
	let lastKey: typeof changeKey | undefined;
	let context = $state.raw<BrowseItem | null>(null),
		smart = $state.raw<SmartPlaylist | 'new' | null>(null),
		addTo = $state.raw<PlayerTrack[] | null>(null),
		savedFilter = $state<LibraryFilter | null>(null);

	function preferences(p: Partial<BrowsePreferences>) {
		const next = { ...settings, ...p };
		if (!saveBrowsePreferences(session, category, next)) settings = next;
	}
	$effect(() => {
		const pinned = $pendingShortcut;
		if (
			!pinned ||
			pinned.session !== session ||
			!active ||
			!ready ||
			loading ||
			category !== 'Playlists'
		)
			return;
		if (error) return;
		const row = (snapshot.items ?? items).find((i) => i.id === pinned.id);
		pendingShortcut.set(null);
		if (row) untrack(() => open(row));
		else
			actionError = tr(
				'This pinned playlist is unavailable in the current library.',
				'このライブラリでは、ピン留めしたプレイリストを利用できません。'
			);
	});
	async function pin(row: BrowseItem, remove: boolean) {
		context = null;
		try {
			await pinPlaylist(session, row.id, row.title, remove);
			receipt = playlistShortcutReceipt(remove);
		} catch (cause) {
			actionError = errorMessage(cause);
		}
	}
	function change(p: Partial<BrowseFilters>) {
		filters = { ...filters, ...p };
	}
	function chooseSort(sort: string) {
		const order =
			sort === 'date_added' || sort === 'year' || sort === 'count' || sort === 'album_count'
				? 'desc'
				: 'asc';
		change({ sort, order });
		preferences({ sort, order });
	}
	function reverse() {
		const order = filters.order === 'asc' ? 'desc' : 'asc';
		change({ order });
		preferences({ order });
	}
	function layout() {
		preferences({ layout: settings.layout === 'grid' ? 'list' : 'grid' });
	}
	function toggle(next: typeof panel) {
		panel = panel === next ? '' : next;
	}
	$effect(() => {
		if (panel === 'search') searchBox?.focus();
	});
	$effect(() => {
		void category;
		void session;
		void availableScope;
		void filters;
		untrack(() => {
			cancelAction();
			receipt = '';
			actionError = '';
		});
	});
	$effect(() => {
		const q = typed;
		const timer = setTimeout(() => {
			if (untrack(() => filters.q) !== q) change({ q });
		}, 180);
		return () => clearTimeout(timer);
	});

	onMount(() => {
		const network = () => (connected = navigator.onLine);
		const favorite = () => retry++;
		const playlistsChanged = () => {
			if (category === 'Playlists') {
				preserveLength = items.length;
				retry++;
			}
		};
		const visibility = () => (visible = !document.hidden);
		window.addEventListener('dn-playlists-updated', playlistsChanged);
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('online', network);
		window.addEventListener('offline', network);
		window.addEventListener('dnfavoritechange', favorite);
		return () => {
			window.removeEventListener('online', network);
			window.removeEventListener('offline', network);
			window.removeEventListener('dnfavoritechange', favorite);
			window.removeEventListener('dn-playlists-updated', playlistsChanged);
			document.removeEventListener('visibilitychange', visibility);
		};
	});
	function cancelAction() {
		actionRequest?.abort();
		actionRequest = undefined;
		busy = false;
		progress = '';
	}
	onDestroy(() => {
		pageRequest?.abort();
		cancelAction();
	});
	$effect(() => {
		const definition = changeKey,
			shown = active && visible;
		if (!ready) return;
		untrack(() => {
			if (!shown) {
				jumpGeneration++;
				jumpNotice = '';
				pageRequest?.abort();
				pageRequest = undefined;
				waitingMore = false;
				if (loading) lastKey = undefined;
				cancelAction();
				wasActive = false;
				return;
			}
			if (!wasActive && returnItem) {
				const id = returnItem;
				returnItem = '';
				requestAnimationFrame(() => {
					if (active && visible) void results?.focusItem(id);
				});
			}
			wasActive = true;
			if (lastKey === definition) {
				pageRequest ??= new AbortController();
				return;
			}
			lastKey = definition;
			jumpGeneration++;
			jumpNotice = '';
			pageRequest?.abort();
			const controller = new AbortController();
			pageRequest = controller;
			const prior = preserveLength;
			preserveLength = 0;
			pages = [];
			cursors.clear();
			snapshot = {};
			if (!prior) {
				items = [];
				total = undefined;
				cursor = null;
			}
			loading = true;
			waitingMore = false;
			error = '';
			scan = '';
			const { a, c, f, m } = definition;
			void browsePage(
				a,
				c,
				f,
				null,
				controller.signal,
				m,
				(n, t) => {
					if (!controller.signal.aborted)
						scan = tr(
							'Reading genre tags · ' + n.toLocaleString() + ' of ' + t.toLocaleString(),
							'ジャンルタグを読み込み中 · ' +
								t.toLocaleString() +
								'件中' +
								n.toLocaleString() +
								'件'
						);
				},
				snapshot
			)
				.then(
					(page) => {
						if (controller.signal.aborted) return;
						if (prior > page.items.length && snapshot.items) {
							items = snapshot.items.slice(0, prior);
							total = snapshot.items.length;
							cursor = items.length < total ? String(items.length) : null;
						} else {
							items = page.items;
							total = page.total;
							cursor = page.next ?? null;
						}
						pages.push({ end: items.length, after: cursor });
						if (cursor) cursors.add(cursor);
					},
					(cause) => {
						if (!controller.signal.aborted) error = errorMessage(cause);
					}
				)
				.finally(() => {
					if (!controller.signal.aborted) {
						loading = false;
						scan = '';
					}
				});
		});
	});
	function more(pageSize?: number) {
		const after = cursor,
			signal = pageRequest?.signal;
		if (!after || !active || !visible || !signal || signal.aborted) return Promise.resolve();
		if (pendingPage?.signal === signal) return pendingPage.promise;
		const promise = appendPage(after, signal, pageSize).finally(() => {
			if (pendingPage?.promise === promise) pendingPage = undefined;
		});
		pendingPage = { signal, promise };
		return promise;
	}
	async function appendPage(after: string, signal: AbortSignal, pageSize?: number) {
		waitingMore = true;
		error = '';
		try {
			const result = await browsePage(
				session,
				category,
				filters,
				after,
				signal,
				available,
				undefined,
				snapshot,
				pageSize
			);
			if (signal.aborted) return;
			if (result.next && (cursors.has(result.next) || !result.items.some((i) => !known.has(i.id))))
				throw Error(
					tr(
						'The collection changed while loading. Try again.',
						'読み込み中にライブラリが更新されました。もう一度お試しください。'
					)
				);
			items = [...items, ...result.items.filter((i) => !known.has(i.id))];
			cursor = result.next ?? null;
			total = result.total ?? total;
			pages.push({ end: items.length, after: cursor });
			if (cursor) cursors.add(cursor);
		} catch (cause) {
			if (!signal.aborted) error = errorMessage(cause);
		} finally {
			if (!signal.aborted) waitingMore = false;
		}
	}
	async function jump(letter: string) {
		const generation = ++jumpGeneration;
		const initial = (row: BrowseItem) => {
			const first = foldSearchText(row.title.trim()).charAt(0).toUpperCase();
			return /^[A-Z]$/.test(first) ? first : '#';
		};
		jumpNotice = '';
		let start = 0;
		while (generation === jumpGeneration) {
			const all = snapshot.items ?? items;
			let found = -1;
			for (let i = start; i < all.length; i++) {
				if (initial(all[i]) === letter) {
					found = i;
					break;
				}
			}
			if (found >= 0) {
				if (found >= items.length && snapshot.items) {
					const next = Math.min(all.length, found + 48);
					items = all.slice(0, next);
					cursor = next < all.length ? String(next) : null;
					pages.push({ end: next, after: cursor });
					if (cursor) cursors.add(cursor);
					await tick();
				}
				if (generation === jumpGeneration) await results?.scrollToIndex(found);
				return;
			}
			if (!cursor || snapshot.items) {
				jumpNotice = tr(
					'No ' + category.toLowerCase() + ' starting with ' + letter + '.',
					'「' + letter + '」で始まる' + uiText(category) + 'はありません。'
				);
				return;
			}
			jumpNotice = tr('Finding ' + letter + '…', '「' + letter + '」を検索中…');
			start = items.length;
			await more(200);
			if (generation !== jumpGeneration) return;
			if (items.length === start) {
				jumpNotice = '';
				return;
			}
			jumpNotice = '';
		}
	}
	type Action = 'open' | 'play' | 'shuffle' | 'next' | 'upNext' | 'end' | 'playlist' | 'offline';
	function open(row: BrowseItem) {
		context = null;
		returnItem = row.id;
		if (row.track) {
			cancelAction();
			try {
				const tracks = (available && snapshot.items ? snapshot.items : items).map((i) => i.track!);
				const batch = tappedPlayback(
					session.serverUrl,
					tracks,
					items.indexOf(row),
					pages,
					total,
					available ? undefined : requestFilters(filters)
				);
				void Promise.resolve(onplay(batch.tracks, batch.index, batch.continuation)).catch(
					(e) => (actionError = errorMessage(e))
				);
			} catch (e) {
				actionError = errorMessage(e);
			}
		} else if (row.album) onopen(row.album);
		else if (row.artist) onlocal(row.artist);
		else if (row.playlist) onplaylist(row.playlist);
		else if (row.genre !== undefined && !row.localTracks) ondetail(row, [], false);
		else void run('open', row);
	}
	async function run(action: Action, row?: BrowseItem) {
		if (busy) return;
		const controller = new AbortController();
		actionRequest = controller;
		const signal = controller.signal,
			forQueue = !['open', 'playlist', 'offline'].includes(action);
		const finish = forQueue
			? beginPlaybackPreparation(() => {
					if (actionRequest === controller) cancelAction();
				})
			: undefined;
		const update = (n: number, t: number) => {
			if (!signal.aborted)
				progress = tr(
					'Preparing tracks · ' + n.toLocaleString() + ' of ' + t.toLocaleString(),
					'曲を準備中 · ' + t.toLocaleString() + '曲中' + n.toLocaleString() + '曲'
				);
		};
		context = null;
		busy = true;
		receipt = '';
		actionError = '';
		progress = tr('Preparing tracks…', '曲を準備中…');
		try {
			const query =
				!available && (action === 'play' || action === 'shuffle')
					? playbackFilter(category, filters, row)
					: undefined;
			if (query) {
				const params = action === 'shuffle' ? { ...query, sort: 'random', order: 'asc' } : query;
				const batch = await prepareLibraryPlayback(session, params, signal, update);
				signal.throwIfAborted();
				finish?.();
				await onplay(batch.tracks, 0, batch.continuation);
				return;
			}
			let tracks = row
				? await resolveItem(session, row, signal, forQueue)
				: await collectionTracks(
						session,
						category,
						filters,
						signal,
						available,
						action === 'shuffle',
						update
					);
			signal.throwIfAborted();
			if (action === 'open') {
				if (row)
					ondetail(
						row,
						tracks,
						disconnected,
						available && (category === 'Albums' || category === 'Playlists')
							? { category, filters }
							: undefined
					);
				return;
			}
			if (!tracks.length)
				throw Error(
					tr(
						'No playable tracks match this selection.',
						'選択した項目には再生可能な曲がありません。'
					)
				);
			if (row && forQueue) {
				const check = queueSizeCheck(session.serverUrl);
				tracks.forEach(check);
				if (action === 'shuffle') tracks = await shuffled(tracks, session);
			}
			signal.throwIfAborted();
			finish?.();
			if (action === 'play' || action === 'shuffle') await onplay(tracks, 0);
			else if (action === 'next' || action === 'upNext' || action === 'end') {
				await player.enqueue(tracks, session, action);
				receipt = placementMessage(action);
			} else if (action === 'playlist') addTo = tracks;
			else if (action === 'offline') {
				const result = await saveOfflineTracks(
					session,
					tracks,
					(n, t) => {
						if (!signal.aborted)
							progress = tr(
								'Saving offline · ' + n + ' of ' + t,
								'オフライン用に保存中 · ' + t.toLocaleString() + '曲中' + n.toLocaleString() + '曲'
							);
					},
					signal
				);
				if (!signal.aborted) receipt = result.message;
			}
		} catch (cause) {
			if (!signal.aborted) actionError = errorMessage(cause);
		} finally {
			finish?.();
			if (actionRequest === controller) {
				actionRequest = undefined;
				busy = false;
				progress = '';
			}
		}
	}
	async function createSection(value: FilterSection) {
		try {
			const owner = await accountId(session),
				current = loadLayout(session.serverUrl, owner, 'library');
			saveLayout(
				session.serverUrl,
				owner,
				'library',
				[...current, { id: value.id, preview: true, title: '', filter: value }],
				{ before: [], after: [value] }
			);
			savedFilter = null;
			receipt = tr('Added to Library sections.', 'ライブラリのセクションに追加しました。');
		} catch (cause) {
			actionError = errorMessage(cause);
		}
	}
	export function getPlaybackAvailability() {
		return availability !== 'all' ? availability : disconnected ? 'offline' : undefined;
	}
	export function getHeader() {
		return categoryHeader;
	}
</script>

{#snippet categoryHeader()}
	<div class="category-heading">
		<button aria-label={uiText('Back to Library')} onclick={onback}
			><ChevronLeft size={23} /></button
		>
		<Icon size={25} />
		<h1>{uiText(category)}</h1>
	</div>
{/snippet}

<SelectionHost
	{session}
	{active}
	{onplay}
	bind:this={host}
	choices={() => items.map((i) => browseChoice(session, i))}
	contains={(id) => known.has(id)}
	externalToggle
	localOnly={disconnected}
	scope={JSON.stringify([category, filters, availability])}
>
	{#snippet tools()}<div class="collection-controls">
			{#if category === 'Playlists'}
				<div class="playlist-actions">
					{#if !disconnected}<PlaylistImport {session} compact onimport={() => retry++} />{/if}
					<button class="pill" onclick={() => (smart = 'new')}
						><Plus size={20} />{uiText('New playlist')}</button
					>
				</div>
			{:else}
				<div class="action-row" aria-label={uiText('Collection actions')} role="group">
					<button
						aria-label={uiText('Play all')}
						title={uiText('Play all')}
						disabled={busy || !items.length}
						onclick={() => run('play')}><Play fill="currentColor" /></button
					>
					<button
						aria-label={uiText('Shuffle all')}
						title={uiText('Shuffle all')}
						disabled={busy || !items.length}
						onclick={() => run('shuffle')}><Shuffle /></button
					>
					<button
						aria-label={uiText('Play next')}
						title={uiText('Play next')}
						disabled={busy || !items.length}
						onclick={() => run('next')}><ListStart /></button
					>
					<button
						aria-label={uiText('Add to queue')}
						title={uiText('Add to queue')}
						disabled={busy || !items.length}
						onclick={() => run('end')}><ListEnd /></button
					>
					<button
						aria-label={uiText('Collection filters')}
						title={uiText('Collection filters')}
						aria-expanded={panel === 'filters'}
						onclick={() => toggle('filters')}><Filter /></button
					>
				</div>
			{/if}
			<div class="browse-tools" aria-label={uiText('Browse controls')} role="group">
				<button
					class="sort-summary"
					aria-label={uiText('Reverse sort order')}
					title={uiText('Reverse sort order')}
					onclick={reverse}
					><span>{uiText(sortLabel)}</span>{#if filters.order === 'asc'}<ArrowUp
							size={15}
						/>{:else}<ArrowDown size={15} />{/if}</button
				>
				{#if category === 'Playlists'}<button
						aria-label={uiText('Collection filters')}
						title={uiText('Collection filters')}
						aria-expanded={panel === 'filters'}
						onclick={() => toggle('filters')}><Filter /></button
					>{/if}
				<button
					aria-label={uiText('Choose sort order')}
					title={uiText('Sort')}
					aria-expanded={panel === 'sort'}
					onclick={() => toggle('sort')}><ArrowDownUp /></button
				>
				<button
					aria-label={settings.layout === 'grid'
						? tr('Switch to list view', 'リスト表示に切り替え')
						: tr('Switch to grid view', 'グリッド表示に切り替え')}
					title={uiText('Switch layout')}
					onclick={layout}
					>{#if settings.layout === 'grid'}<List />{:else}<Grid2X2 />{/if}</button
				>
				<button
					aria-label={searchLabel}
					title={searchLabel}
					aria-expanded={panel === 'search'}
					onclick={() => toggle('search')}><Search /></button
				>
				<button
					aria-label={uiText('Collection options')}
					title={uiText('Collection options')}
					aria-expanded={panel === 'display'}
					onclick={() => toggle('display')}><EllipsisVertical /></button
				>
			</div>
		</div>{/snippet}
	{#if panel === 'search'}
		<div class="search">
			<input
				type="search"
				aria-label={tr('Filter ' + unit, uiText(category) + 'を絞り込む')}
				placeholder={searchLabel}
				bind:value={typed}
				bind:this={searchBox}
			/><button
				aria-label={uiText('Clear search')}
				onclick={() => {
					typed = '';
					change({ q: '' });
					searchBox?.focus();
				}}><X size={18} /></button
			>
		</div>
	{:else if panel === 'sort'}
		<div class="control-panel">
			<label
				>{tr('Sort ' + unit, uiText(category) + 'の並べ替え')}<InlineChoice selected={filters.sort}
					><select value={filters.sort} onchange={(e) => chooseSort(e.currentTarget.value)}
						>{#each orderChoices[category] as [value, label] (value)}<option {value}
								>{uiText(label)}</option
							>{/each}</select
					></InlineChoice
				></label
			>
		</div>
	{:else if panel === 'filters'}
		<LibraryFilters
			{session}
			{category}
			{filters}
			{change}
			{availability}
			{chooseAvailability}
			local={!!available}
			{localFormats}
			onsave={category !== 'Genres' && category !== 'Playlists'
				? () => (savedFilter = libraryFilter({ ...filters, query: filters.q, kind }))
				: undefined}
		/>
	{:else if panel === 'display'}
		<div class="control-panel">
			<CollectionDisplayFields {settings} onchange={preferences} />
			{#if category === 'Genres' && !available}<p class="index-note">
					{uiText(
						'The directory lists each track’s primary genre. Opening a genre includes other tracks DN has tagged with it.'
					)}
				</p>{/if}
		</div>
	{/if}
	{#if !loading && !error}
		{@const count = total ?? items.length}
		{@const number = count.toLocaleString()}
		<p class="count" aria-live="polite">
			{total === undefined && cursor
				? tr(number + ' loaded', number + '件を読み込み済み')
				: tr(number + (count === 1 ? ' item' : ' items'), number + '件')}{#if available}<span>
					· {availability === 'downloaded'
						? uiText('Downloaded')
						: availability === 'automatic'
							? uiText('Automatically saved')
							: availability === 'cached'
								? uiText('Playback cache')
								: uiText('Available offline')}</span
				>{/if}
		</p>
	{/if}
	{#if busy}<p role="status" class="notice">
			{progress}
			<button class="text-button" onclick={cancelAction}>{uiText('Cancel preparation')}</button>
		</p>{/if}
	{#if actionError}<p role="alert">{actionError}</p>{/if}{#if receipt}<p role="status">
			{receipt}
		</p>{/if}
	{#if loading}<p class="notice" role="status">
			{scan || tr('Loading ' + category.toLowerCase() + '…', uiText(category) + 'を読み込み中…')}
		</p>{/if}
	{#if error}<p role="alert">{error}</p>
		<button class="secondary" onclick={() => (items.length && cursor ? more() : retry++)}
			>{uiText('Retry')}</button
		>{/if}
	{@const alphabet =
		(category === 'Albums' || category === 'Artists') &&
		filters.sort === 'name' &&
		(total ?? 0) > 30 &&
		!host?.isSelecting()}
	<div class:alphabet style:--result-columns={settings.layout === 'grid' ? settings.columns : 1}>
		<div class="result-column">
			<BrowseEntries
				bind:this={results}
				{active}
				{total}
				{session}
				{items}
				{category}
				layout={settings.layout}
				columns={settings.columns}
				compact={settings.compact}
				{inventory}
				localOnly={disconnected}
				{open}
				menu={(row) => (context = row)}
			/>
		</div>
		{#if alphabet}<AlphabetRail
				descending={filters.order === 'desc'}
				onjump={jump}
				notice={jumpNotice}
			/>{/if}
	</div>
	{#if !loading && !error && !items.length}<p class="notice">
			{tr(
				'No matching ' + category.toLowerCase() + '.',
				'一致する' + uiText(category) + 'はありません。'
			)}
		</p>{/if}
	{#if cursor}<button
			class="secondary more-page"
			data-selection-more={error ? undefined : true}
			use:loadNearEnd={{ active, enabled: !error && !waitingMore && !loading, load: more }}
			disabled={waitingMore}
			onclick={() => more()}
			>{waitingMore
				? uiText('Loading…')
				: tr('More ' + unit, uiText(category) + 'をさらに表示')}</button
		>{/if}
</SelectionHost>

{#if context}<BrowseItemMenu
		{session}
		row={context}
		{category}
		offline={disconnected}
		onclose={() => (context = null)}
		onopen={open}
		action={run}
		onpin={launcherShortcuts && session.userId
			? (remove) => {
					if (context) void pin(context, remove);
				}
			: undefined}
		edit={(rule) => {
			smart = rule;
			context = null;
		}}
	/>{/if}
{#if smart}<PlaylistEditor
		{session}
		initial={smart === 'new' ? undefined : smart}
		{disconnected}
		onblank={(item) => {
			smart = null;
			panel = '';
			onplaylist(item);
		}}
		onclose={() => (smart = null)}
		oncreated={() => {
			smart = null;
			retry++;
		}}
	/>{/if}
{#if addTo}<AddToPlaylist {session} tracks={addTo} onclose={() => (addTo = null)} />{/if}
{#if savedFilter}<FilterSectionDialog
		initial={savedFilter}
		onclose={() => (savedFilter = null)}
		onsave={createSection}
	/>{/if}

<style>
	.alphabet {
		--alphabet-rail-width: 28px;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		/* The alphabet can use the page's end padding when it would shrink the tap targets. */
		margin-inline-end: clamp(
			calc(-1 * var(--gap)),
			calc(100% - var(--result-columns) * 44px - var(--alphabet-rail-width)),
			0px
		);
	}
	.result-column {
		min-width: 0;
	}
	.collection-controls {
		width: 100%;
	}
	.category-heading,
	.browse-tools,
	.playlist-actions,
	.search {
		display: flex;
		align-items: center;
		min-width: 0;
	}
	.category-heading {
		gap: 0.38rem;
		flex: 1;
	}
	.category-heading h1 {
		flex: 1;
		margin: 0;
		font-size: clamp(1.65rem, 7vw, 2.1rem);
		line-height: 1.12;
	}
	.category-heading button,
	.browse-tools button,
	.search button {
		min-width: 44px;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.action-row {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 0.5rem;
		margin: 0.3rem 0 1.05rem;
	}
	.action-row button,
	.pill,
	.playlist-actions :global(.import-pill) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--accent);
		color: var(--on-accent);
		border-radius: 999px;
	}
	.action-row button {
		justify-self: center;
		width: clamp(44px, 12.8vw, 57px);
		height: auto;
		aspect-ratio: 1;
	}
	.action-row button :global(svg) {
		width: clamp(21px, 6vw, 26px);
		height: auto;
	}
	.action-row button[aria-expanded='true'] {
		outline: 2px solid var(--text);
		outline-offset: 2px;
	}
	.playlist-actions {
		gap: 0.5rem;
		margin: 0 0 1.05rem;
		flex-wrap: wrap;
	}
	.pill,
	.playlist-actions :global(.import-pill) {
		gap: 0.35rem;
		min-height: 44px;
		padding: 0.25rem 0.8rem;
		font-weight: 650;
	}
	.browse-tools {
		border-top: 1px solid var(--line);
		padding-top: 0.23rem;
		color: var(--muted);
	}
	.browse-tools button {
		padding: 0.15rem;
	}
	.browse-tools .sort-summary {
		min-width: 0;
		flex: 1;
		justify-content: flex-start;
		gap: 0.27rem;
		text-align: start;
		font-size: 0.85rem;
	}
	.sort-summary span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.browse-tools button :global(svg) {
		width: 20px;
		height: 20px;
		flex: none;
	}
	.sort-summary :global(svg) {
		width: 14px !important;
	}
	.browse-tools button[aria-expanded='true'] {
		color: var(--accent);
	}
	.search,
	.control-panel {
		padding: 0.4rem 0.15rem 0.55rem;
		gap: 0.45rem;
	}
	.search input,
	.control-panel select {
		width: 100%;
		min-width: 0;
	}
	.control-panel {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		align-items: end;
	}
	.index-note {
		grid-column: 1/-1;
		margin: 0.2rem 0;
		font-size: 0.82rem;
	}
	.control-panel label {
		font-size: 0.85rem;
		display: grid;
		gap: 0.2rem;
	}
	.count,
	.notice {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.count {
		margin: 0.1rem 0 0.55rem;
	}
	.more-page {
		margin-top: 0.8rem;
		width: 100%;
	}
</style>
