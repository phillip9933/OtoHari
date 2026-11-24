<script lang="ts">
	import { uiText } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import type { Preview } from '../boards/display';
	import type { Session } from '../connection';
	import { errorMessage, type Album, type OnPlay } from './catalog';
	import type { ChartRange, DiscoverArtistRef } from './discovery';
	import {
		isChart,
		playableSong,
		readWidget,
		type ShelfSong,
		type WidgetResult
	} from './discoveryWidgets';
	import FollowingUpdates from './FollowingUpdates.svelte';
	import DiscoveryPreview from './DiscoveryPreview.svelte';
	import RadioGuide from './RadioGuide.svelte';
	import DiscoverDeck from './DiscoverDeck.svelte';
	import DiscoverGenres from './DiscoverGenres.svelte';
	let {
		id,
		display,
		session,
		onopen,
		onartist,
		ongenre,
		onplay,
		expanded = false,
		active = true
	}: {
		id: string;
		session: Session;
		display: Preview;
		onopen: (a: Album) => void;
		ongenre?: (name: string) => void;
		onartist: (a: DiscoverArtistRef) => void;
		onplay: OnPlay;
		active?: boolean;
		expanded?: boolean;
		onexpand: () => void;
	} = $props();
	let range = $state<ChartRange>('this_month'),
		offsets = $state<number[]>([0]),
		selectedPlaylist = $state(''),
		retry = $state(0);
	let data = $state<WidgetResult | null>(null),
		error = $state(''),
		busy = $state(true),
		songStatus = $state(''),
		pendingSong = $state<ShelfSong | null>(null);
	let tap = 0;
	let lastLoad = '',
		lastSession: Session | undefined;
	const rows = $derived(data?.shelves ?? []);
	const concerts = $derived(data?.concerts ?? []);
	const options = $derived(data?.playlists ?? []);
	const hasRows = $derived(
		rows.some(
			(s) =>
				s.albums.length ||
				s.artists.length ||
				s.unlinked.length ||
				s.songs.length ||
				s.genres.length ||
				s.note ||
				s.radio
		) || concerts.length
	);
	const genreWidget = $derived(id === 'discover-genre_list' || id === 'discover-unexplored_genres');
	const previewCapacity = $derived(
		!expanded && (isChart(id) || id === 'discover-playlist_discovery')
			? display.capacity
			: undefined
	);
	function pickPlaylist(value: string) {
		selectedPlaylist = value;
	}
	$effect(() => {
		const key = id,
			account = session,
			period = range,
			offset = offsets.at(-1) ?? 0,
			choice = selectedPlaylist,
			capacity = previewCapacity;
		void retry;
		if (!active) return;
		let current = true,
			timer: ReturnType<typeof setTimeout>,
			checks = 0;
		const nextLoad = JSON.stringify([key, period, offset, choice, capacity]);
		if (lastLoad !== nextLoad || lastSession !== account) {
			busy = true;
			data = null;
		}
		lastLoad = nextLoad;
		lastSession = account;
		error = '';
		songStatus = '';
		pendingSong = null;
		async function load() {
			try {
				const result = await readWidget(account, key, period, offset, choice, capacity);
				if (!current) return;
				data = result;
				if (result.refreshing && checks++ < 6)
					timer = setTimeout(() => {
						if (!document.hidden && current) void load();
					}, 15000);
			} catch (cause) {
				if (current) error = errorMessage(cause);
			} finally {
				if (current) busy = false;
			}
		}
		void load();
		return () => {
			current = false;
			tap++;
			clearTimeout(timer);
		};
	});
	async function playSong(row: ShelfSong) {
		if (pendingSong) return;
		const token = ++tap;
		pendingSong = row;
		songStatus = '';
		try {
			const track = await playableSong(session, row);
			if (token !== tap) return;
			if (track) await onplay([track], 0);
			else songStatus = `${row.title} is unavailable in your library.`;
		} catch (cause) {
			if (token === tap) songStatus = errorMessage(cause);
		} finally {
			if (token === tap) pendingSong = null;
		}
	}
	const empty: Record<string, string> = {
		'discover-following': 'Artists you follow will appear here.',
		'discover-concerts': 'No upcoming concerts for your followed artists.',
		'discover-releases': 'No releases from followed artists in the last 90 days.'
	};
</script>

<div class="widget" data-part="discovery-feature" data-feature={id}>
	{#if expanded && isChart(id)}<label
			>{uiText('Chart period')}<InlineChoice selected={range}
				><select bind:value={range} onchange={() => (offsets = [0])}
					><option value="this_week">{uiText('This week')}</option><option value="this_month"
						>{uiText('This month')}</option
					><option value="this_year">{uiText('This year')}</option><option value="all_time"
						>{uiText('All time')}</option
					></select
				></InlineChoice
			></label
		>{/if}
	{#if busy}<p role="status">{uiText('Loading…')}</p>{:else if error}<p role="alert">{error}</p>
		<button class="text-button" onclick={() => retry++}>{uiText('Try again')}</button>
	{:else if data}
		{#if expanded && active && (id === 'discover-concerts' || id === 'discover-releases')}
			{#key session.serverUrl + ':' + session.userId + ':' + id}<FollowingUpdates
					{session}
					concerts={id === 'discover-concerts'}
					onchanged={() => retry++}
				/>{/key}
		{/if}
		{#if data.notice}<p>{data.notice}</p>{/if}
		{#if data.playlists}
			{#if options.length}
				<label
					>{uiText('Choose a playlist')}<InlineChoice selected={selectedPlaylist}
						><select value={selectedPlaylist} onchange={(e) => pickPlaylist(e.currentTarget.value)}
							><option value="">{uiText('Select a playlist')}</option
							>{#each options as p (p.id)}<option value={p.id}>{p.name}</option>{/each}</select
						></InlineChoice
					></label
				>
			{:else}<p>{uiText('Create a playlist in your library to get suggestions for it.')}</p>{/if}
		{/if}
		{#if expanded && data.cards}{#key [session.serverUrl, session.userId, id].join('|')}<DiscoverDeck
					{session}
					{active}
					cards={data.cards}
					queue={id === 'discover-discover_queue'}
					{onopen}
					onrefresh={() => retry++}
				/>{/key}{:else if genreWidget && expanded && !data.notice}<DiscoverGenres
				{session}
				{onopen}
				{onartist}
				{onplay}
				{active}
				names={rows.flatMap((s) => s.genres)}
			/>
		{:else if id === 'discover-radio_sections'}<RadioGuide
				shelves={rows}
				{display}
				{session}
				{onopen}
				{onartist}
				{onplay}
				onplaysong={playSong}
				{ongenre}
			/>
		{:else}<DiscoveryPreview
				{active}
				{display}
				{data}
				{session}
				{onopen}
				{onartist}
				{onplay}
				{ongenre}
				onplaysong={playSong}
			/>{/if}
		{#if !data.notice && !hasRows && !(expanded && data.cards) && !data.playlists && !(genreWidget && expanded)}<p
			>
				{empty[id] ?? uiText('No items for this section yet.')}
			</p>{/if}
		{#if expanded && isChart(id) && (offsets.length > 1 || data.next != null)}<div class="pages">
				<button
					class="secondary"
					disabled={offsets.length === 1}
					onclick={() => (offsets = offsets.slice(0, -1))}>{uiText('Previous')}</button
				><span>{uiText('Page')} {offsets.length}</span><button
					class="secondary"
					disabled={data.next == null}
					onclick={() => {
						if (data?.next != null) offsets = [...offsets, data.next];
					}}>{uiText('Next')}</button
				>
			</div>{/if}
		{#if pendingSong}<p role="status">
				{uiText('Finding')}
				{pendingSong.title}
				{uiText('in your library…')}
			</p>{:else if songStatus}<p role="status">{songStatus}</p>{/if}
	{/if}
</div>

<style>
	.widget {
		min-width: 0;
	}
	.widget p {
		color: var(--muted);
	}
	label {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.7rem;
		margin-block: 0.55rem;
	}
	.pages {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		flex-wrap: wrap;
	}

	.pages {
		justify-content: space-between;
	}
	select {
		max-width: 100%;
		min-height: 44px;
	}
</style>
