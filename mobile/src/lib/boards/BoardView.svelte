<script lang="ts">
	import { uiText, tr } from '../i18n';
	import { onMount } from 'svelte';
	import {
		getVisibility,
		sharedSection,
		visibilityEvent,
		type SectionPrefs
	} from './sectionVisibility';
	import { revealScreen } from '../appearance/interface';
	import { ArrowLeft, ChevronRight, PanelsTopLeft, Download, ListFilterPlus } from '@lucide/svelte';
	import type { Session } from '../connection';
	import { catalogSource } from '../catalog/catalogSource.svelte';
	import { availableTracks } from '../offline/library';
	import { errorMessage } from '../catalog/catalog';
	import type { BrowseItem } from '../catalog/libraryBrowse';
	import LibraryGroup from '../catalog/LibraryGroup.svelte';
	import LibraryShelf from './LibraryShelf.svelte';
	import { shelfRows } from './shelfLibrary';
	import type { Album, OnPlay } from '../catalog/catalog';
	import type { DiscoverArtistRef } from '../catalog/discovery';
	import type { Playlist } from '../catalog/playlists';
	import FilterSectionDialog from './FilterSectionDialog.svelte';
	import { type LibraryFilter, type FilterSection } from './filteredSections';
	import SelectionHost from '../catalog/SelectionHost.svelte';
	import LibraryWidget from '../catalog/LibraryWidget.svelte';
	import DiscoveryWidget from '../catalog/DiscoveryWidget.svelte';
	import type { Preview } from './display';
	import PreviewViewport from './PreviewViewport.svelte';
	import HomePins from './HomePins.svelte';
	import MixBuilder from '../catalog/MixBuilder.svelte';
	import {
		accountId,
		boardNames,
		loadLayout,
		sectionTitle,
		saveLayout,
		type Board,
		type Section
	} from './layout';

	let {
		board,
		session,
		active,
		onopen,
		onartist,
		ongenre,
		onlocal,
		onplaylist,
		onplay,
		onrootback,
		onoffline
	}: {
		board: Board;
		session: Session;
		active: boolean;
		onopen: (album: Album) => void;
		ongenre?: (name: string) => void;
		onartist: (a: DiscoverArtistRef) => void;
		onlocal: (a: { id: string; name: string }) => void;
		onplaylist: (p: Playlist) => void;
		onplay: OnPlay;
		onoffline?: () => void;
		onrootback?: () => void;
	} = $props();
	let owner = $state(''),
		sections = $state<Section[]>([]),
		error = $state('');
	let visibility = $state.raw<SectionPrefs>();
	const visibleSections = $derived(
		sections.filter(
			(item) =>
				board === 'library' || sharedSection(visibility?.pages[board], item.id)?.enabled !== false
		)
	);
	$effect(() => {
		const account = session;
		visibility = undefined;
		if (!active || board === 'library' || !source.ready || source.useDevice) return;
		let request: AbortController | undefined;
		function refresh() {
			if (document.visibilityState === 'hidden' || !navigator.onLine) return;
			request?.abort();
			const job = new AbortController();
			request = job;
			void getVisibility(account, job.signal)
				.then((prefs) => {
					if (!job.signal.aborted) visibility = prefs;
				})
				.catch(() => {
					/* Older servers and offline devices use their saved layout. */
				});
		}
		function saved(event: Event) {
			const d = (event as CustomEvent<{ session: Session; prefs: SectionPrefs }>).detail;
			if (account.serverUrl === d.session.serverUrl && account.token === d.session.token) {
				request?.abort();
				visibility = d.prefs;
			}
		}
		refresh();
		window.addEventListener(visibilityEvent, saved);
		window.addEventListener('online', refresh);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			request?.abort();
			window.removeEventListener(visibilityEvent, saved);
			window.removeEventListener('online', refresh);
			document.removeEventListener('visibilitychange', refresh);
		};
	});
	let newFilter = $state<Partial<LibraryFilter> | null>(null);
	function createFilter(value: FilterSection) {
		const current = loadLayout(session.serverUrl, owner, board);
		saveLayout(
			session.serverUrl,
			owner,
			board,
			[...current, { id: value.id, preview: true, title: '', filter: value }],
			{ before: [], after: [value] }
		);
		newFilter = null;
		expanded = null;
		scroll(0);
	}
	let expanded = $state<Section | null>(null);
	let root: HTMLElement;
	let group = $state.raw<{ row: BrowseItem; section: Section; device: boolean } | null>(null),
		groupScroll = 0;
	let groupView = $state<LibraryGroup>();
	const source = catalogSource(
		() => session,
		() => active,
		() => !!group?.device
	);
	const deviceShelves = $derived(source.useDevice || !!group?.device);
	const tracks = $derived(source.inventory ? availableTracks(source.inventory) : undefined);
	const localDetail = $derived(!!group && (group.device || source.useDevice));
	let detailRow = $state.raw<BrowseItem>(),
		detailError = $state(''),
		detailRetry = $state(0);
	$effect(() => {
		const detail = group,
			music = tracks;
		void detailRetry;
		if (!active || !detail || !localDetail || !music) return;
		const request = new AbortController();
		detailError = '';
		void shelfRows(session, detail.section, music, request.signal).then(
			(rows) => {
				const match = rows.find(
					(row) =>
						row.id === detail.row.id ||
						(detail.row.genre !== undefined &&
							row.id === 'Genres:' + detail.row.genre.toLocaleLowerCase())
				);
				if (!request.signal.aborted) detailRow = match;
			},
			(e) => {
				if (!request.signal.aborted) detailError = errorMessage(e);
			}
		);
		return () => request.abort();
	});
	function openGroup(section: Section, row: BrowseItem) {
		groupScroll = root.closest('main')?.scrollTop ?? 0;
		group = { section, row, device: source.useDevice };
		detailRow = row;
		detailError = '';
		scroll(0);
	}
	export function getPlaybackAvailability() {
		if (groupView) return groupView.getPlaybackAvailability();
		return source.useDevice || group?.device ? 'offline' : undefined;
	}

	let offset = 0;
	let live = false;
	async function load() {
		error = '';
		try {
			if (!session.userId && !navigator.onLine) throw Error('Reconnect to identify this listener.');
			const id = await accountId(session);
			if (!live) return;
			sections = loadLayout(session.serverUrl, id, board);
			owner = id;
		} catch {
			if (live) error = 'Could not load your layout. Check your connection and try again.';
		}
	}
	onMount(() => {
		live = true;
		void load();
		function changed(event: Event) {
			const d = (
				event as CustomEvent<{
					server: string;
					user: string;
					board: string;
					filtersChanged?: boolean;
				}>
			).detail;
			if (
				d.server !== session.serverUrl ||
				d.user !== owner ||
				(d.board !== board && !d.filtersChanged)
			)
				return;
			sections = loadLayout(session.serverUrl, owner, board);
			if (expanded) expanded = sections.find((s) => s.id === expanded?.id) ?? null;
		}
		window.addEventListener('dn-layout-change', changed);
		return () => {
			window.removeEventListener('dn-layout-change', changed);
			live = false;
		};
	});
	function scroll(y: number) {
		revealScreen({
			content: root,
			restore: () => {
				const main = root.closest('main');
				main?.scrollTo(0, y);
				main?.focus({ preventScroll: true });
			}
		});
	}
	function enter(item: Section) {
		offset = root.closest('main')?.scrollTop ?? 0;
		expanded = item;
		scroll(0);
	}
	export function goBack() {
		if (group) {
			group = null;
			detailRow = undefined;
			scroll(groupScroll);
			return true;
		}
		if (!expanded) return false;
		expanded = null;
		scroll(offset);
		return true;
	}
</script>

{#snippet widget(item: Section, full: boolean, display: Preview)}
	{#if deviceShelves && (item.id.startsWith('discover-') || item.id === 'library-recently-played')}
		<p>
			{item.id === 'library-recently-played'
				? uiText('Connect to DroppedNeedle to view your listening history.')
				: uiText('Connect to DroppedNeedle to load this Discover section.')}
		</p>
	{:else if deviceShelves || item.id === 'library-genres'}
		{#if !deviceShelves || tracks}<LibraryShelf
				section={item}
				{display}
				expanded={full}
				{session}
				tracks={deviceShelves ? tracks : undefined}
				active={active && !group && (full || !expanded)}
				onopen={(row) => openGroup(item, row)}
				{onplay}
			/>
		{:else if !source.storageError}<p role="status">{uiText('Opening saved music…')}</p>{/if}
	{:else if item.id.startsWith('library-')}
		<LibraryWidget
			filter={item.filter}
			onsavefilters={board !== 'discover' ? (config) => (newFilter = config) : undefined}
			id={item.id}
			{session}
			{onopen}
			onartist={onlocal}
			{onplaylist}
			{onplay}
			active={active && !group && (full || !expanded)}
			expanded={full}
			{display}
			onexpand={() => enter(item)}
		/>
	{:else}
		<DiscoveryWidget
			{ongenre}
			id={item.id}
			{session}
			{onopen}
			{onartist}
			{onplay}
			active={active && !group && (full || !expanded)}
			expanded={full}
			{display}
			onexpand={() => enter(item)}
		/>
	{/if}
{/snippet}

<div bind:this={root} data-board={board}>
	{#if source.policyIssue}<p role="alert">{source.policyIssue}</p>
		<button class="text-button" onclick={source.retryPolicy}
			>{uiText('Retry offline settings')}</button
		>
	{:else if !source.ready}<p role="status">{uiText('Opening sections…')}</p>
	{:else}
		{#if group}
			{#if !/^Albums:|^Artists:/.test(group.row.id)}<button class="text-button" onclick={goBack}
					><ArrowLeft size={17} />
					{uiText('Back to')}
					{expanded ? sectionTitle(expanded) : uiText(boardNames[board])}</button
				>{/if}
			{#if detailError || source.storageError}<p role="alert">
					{detailError || source.storageError}
				</p>
				<button
					class="text-button"
					onclick={() => {
						detailRetry++;
						source.retryStorage();
					}}>{uiText('Retry collection')}</button
				>{/if}
			{#key group.row.id + localDetail}
				<LibraryGroup
					bind:this={groupView}
					onback={goBack}
					backLabel={uiText('Back to') +
						' ' +
						(expanded ? sectionTitle(expanded) : uiText(boardNames[board]))}
					source={localDetail ? source : undefined}
					{session}
					{active}
					{onplay}
					item={localDetail
						? { ...group.row, localTracks: detailRow?.localTracks ?? [] }
						: group.row}
					tracks={localDetail ? (detailRow?.localTracks ?? []) : []}
					offline={localDetail}
				/>
			{/key}
		{/if}
		<div hidden={!!group}>
			{#if deviceShelves}<p class="source">{uiText('Music on this device')}</p>
				{#if source.storageError}<p role="alert">{source.storageError}</p>
					{#if session.userId}<button class="text-button" onclick={source.retryStorage}
							>{uiText('Retry device library')}</button
						>{/if}{/if}{/if}
			{#if expanded}
				<div class="detailbar">
					<button class="text-button" onclick={goBack}
						><ArrowLeft size={17} /> {uiText('Back to')} {uiText(boardNames[board])}</button
					>
				</div>
				<SelectionHost
					{session}
					{onplay}
					active={active && !group}
					localOnly={deviceShelves}
					enabled={board === 'library' || (board === 'home' && expanded.id.startsWith('library-'))}
					scope={expanded.id + (deviceShelves ? '/device' : '/dn')}
					heading={sectionTitle(expanded)}
				>
					{@const selected = expanded}
					<PreviewViewport section={selected} expanded>
						{#snippet children(display)}{@render widget(selected, true, display)}{/snippet}
					</PreviewViewport>
				</SelectionHost>
			{/if}
			<div hidden={!!expanded} data-home-feed={board === 'home' ? '' : undefined}>
				{#if onrootback}<button class="text-button" onclick={onrootback}
						><ArrowLeft size={17} />{uiText('Back to Library')}</button
					>{/if}
				<SelectionHost
					{session}
					{onplay}
					active={active && !expanded && !group}
					localOnly={deviceShelves}
					enabled={board === 'library'}
					scope={board + (deviceShelves ? '/device' : '/dn')}
					heading={uiText(boardNames[board])}
				>
					{#snippet tools()}
						{#if board === 'library'}
							{#if owner}<button class="board-action secondary" onclick={() => (newFilter = {})}
									><ListFilterPlus size={17} />{uiText('New filtered section')}</button
								>{/if}
							{#if onoffline}<button class="board-action secondary" onclick={onoffline}
									><Download size={17} />{uiText('Offline music')}</button
								>{/if}
						{/if}
					{/snippet}
					{#if owner && board === 'home'}<HomePins
							{session}
							{owner}
							active={active && !expanded && !group}
							offline={deviceShelves}
							available={tracks}
							{onopen}
							{onartist}
							{onlocal}
							{onplaylist}
							{ongenre}
							{onplay}
							onnetworkerror={source.connectionFailed}
						/>{/if}
					{#if owner && board === 'discover'}<MixBuilder
							{session}
							{owner}
							{onplay}
							offline={deviceShelves}
							available={tracks}
						/>{/if}
					{#if error}<p role="alert">{error}</p>
						<button class="text-button" onclick={load}>{uiText('Try again')}</button>
					{:else if !owner}<p role="status">{uiText('Loading layout…')}</p>
					{:else if !visibleSections.length}<div class="empty">
							<PanelsTopLeft size={28} />
							<p>
								{uiText('Choose sections for')}
								{uiText(boardNames[board])}
								{uiText('in Settings.')}
							</p>
						</div>
					{:else}
						{#each visibleSections as item (item.id)}
							<section
								class:shortcut={!item.preview}
								class="shelf"
								data-widget={item.id}
								aria-label={sectionTitle(item)}
							>
								<h2>
									<button
										aria-label={tr('Browse ' + sectionTitle(item), sectionTitle(item) + 'を表示')}
										onclick={() => enter(item)}
										><span>{sectionTitle(item)}</span><ChevronRight size={20} /></button
									>
								</h2>
								{#if item.preview}<PreviewViewport section={item}
										>{#snippet children(display)}{@render widget(
												item,
												false,
												display
											)}{/snippet}</PreviewViewport
									>{/if}
							</section>
						{/each}
					{/if}
				</SelectionHost>
			</div>
		</div>{/if}
</div>

{#if newFilter}<FilterSectionDialog
		initial={newFilter}
		onclose={() => (newFilter = null)}
		onsave={createFilter}
	/>{/if}

<style>
	[data-home-feed] :global(.heading h1) {
		margin-block: 0.35rem 0.45rem;
	}
	.source {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.board-action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		gap: 0.45rem;
		padding: 0.35rem 0.7rem;
	}

	.detailbar,
	.shelf h2 button {
		display: flex;
		align-items: center;
	}
	.detailbar {
		justify-content: space-between;
		gap: var(--gap);
	}
	.shelf {
		min-width: 0;
		margin-bottom: 1.3rem;
	}
	.shelf h2 {
		margin: 0 0 0.4rem;
	}
	.shelf h2 button {
		justify-content: space-between;
		gap: var(--gap);
		width: 100%;
		min-height: 44px;
		font: inherit;
		text-align: left;
		overflow-wrap: anywhere;
	}
	.shelf h2 :global(svg) {
		color: var(--muted);
	}
	.shortcut {
		margin: 0;
		border-top: 1px solid var(--line);
	}
	.shortcut h2 {
		margin: 0;
	}
	.shortcut h2 button {
		min-height: 54px;
	}
	.shortcut + .shelf:not(.shortcut) {
		margin-top: 1.2rem;
	}
	.detailbar {
		margin-bottom: var(--gap);
	}
	.empty {
		padding: 1.4rem var(--gap);
		background: var(--surface);
		border-radius: var(--radius);
	}
	.empty :global(svg) {
		color: var(--muted);
	}
</style>
