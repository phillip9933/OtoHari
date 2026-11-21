<script lang="ts">
	import { uiText, uiFormat, tr } from './i18n';

	import {
		ListMusic,
		ListPlus,
		EllipsisVertical,
		MicVocal,
		Info,
		SlidersHorizontal,
		Disc3,
		UserRound,
		Pause,
		Play,
		SkipBack,
		SkipForward,
		AudioLines,
		Minus,
		Repeat,
		Repeat1,
		Shuffle
	} from '@lucide/svelte';
	import { Capacitor } from '@capacitor/core';
	import { GRID_COLUMNS, GRID_ROWS, isPlayerGrid } from './player/grid';
	import { fitPlayer } from './player/fitPlayer';
	import PlayerSheet from './player/PlayerSheet.svelte';
	import PlayerProgress from './player/PlayerProgress.svelte';
	import PlayerQuality from './player/PlayerQuality.svelte';
	import SignalPath from './player/SignalPath.svelte';
	import AutoplaySuggestions from './player/AutoplaySuggestions.svelte';

	import EqualizerSettings from './player/EqualizerSettings.svelte';
	import SoundSettings from './player/SoundSettings.svelte';
	import type { Snippet } from 'svelte';
	import { samplePlayer } from './player/samplePlayer';
	import sampleArt from './player/tidal-memory.webp';
	import PlayerActionFace from './player/PlayerActionFace.svelte';
	import PlayerNavigationAction from './player/PlayerNavigationAction.svelte';
	import PlayerMetadata from './player/PlayerMetadata.svelte';
	import type { Credit } from './player/related';
	import PlayerHeader from './player/PlayerHeader.svelte';
	import SleepTimer from './player/SleepTimer.svelte';
	import {
		isPlayerMetadata,
		isNavigation,
		fieldSizing,
		trackToolFields,
		usesFieldCaption
	} from './player/layout';
	import { player, queueOrder, type PlayerTrack } from './player';
	import ReorderList from './controls/ReorderList.svelte';
	import { defaultMiniPlayer, readMiniPlayer, type MiniButton } from './appearance/interface';
	import { swipeTracks } from './player/swipeTracks';
	import { accountId, defaults, loadLayout, sectionTitle, type Section } from './boards/layout';
	import {
		formatPlayerText,
		isPlayerSlot,
		isPlayerText,
		playerCanvas,
		playerColumns,
		playerRowGap
	} from './player/composition';
	import TrackTools from './player/TrackTools.svelte';
	import AddToPlaylist from './catalog/AddToPlaylist.svelte';
	import type { Session } from './connection';
	import Cover from './catalog/Cover.svelte';
	import PlayerLyrics from './PlayerLyrics.svelte';
	let {
		session,
		expanded,
		transient = false,
		artworkLyrics = $bindable(false),
		editing = $bindable(false),
		queueOpen = false,
		ontogglequeue,
		onsettings,
		onexpand,
		oncollapse,
		onerror,
		oncredit,
		editor
	}: {
		session: Session;
		expanded: boolean;
		transient?: boolean;
		artworkLyrics?: boolean;
		editing?: boolean;
		queueOpen?: boolean;
		ontogglequeue?: () => void;
		onsettings?: () => void;
		onexpand: () => void;
		oncollapse: () => void;
		onerror: (error: unknown) => void;
		oncredit?: (kind: Credit, track: PlayerTrack, control: HTMLElement) => void;
		editor?: {
			sections: Section[];
			selected?: string;
			overlay?: Snippet<[Section, number, number]>;
			gridOverlay?: Snippet;
			inspector?: Snippet<[number]>;
			rowControls?: Snippet<[number]>;
		};
	} = $props();
	let saveQueue = $state<PlayerTrack[] | null>(null);
	let queueScrolled = $state(false);
	let loaded = $state(defaults('player'));
	// A draft without editing overlays uses the same sample music in a read-only player.
	const composing = $derived(!!editor?.overlay);
	const previewOnly = $derived(!!editor && !composing);
	const sampleDetails = new Set([
		'player-artwork',
		'player-track',
		'player-elapsed',
		'player-duration',
		'player-remaining',
		'player-quality'
	]);
	const sections = $derived(editor?.sections ?? loaded);
	const store = $derived(editor ? samplePlayer : player);
	$effect(() => {
		if (!expanded || editor) return;
		const current = session;
		let live = true,
			owner = '';
		loaded = defaults('player');
		accountId(current)
			.then((id) => {
				if (!live) return;
				owner = id;
				loaded = loadLayout(current.serverUrl, id, 'player');
			})
			.catch(() => {
				/* The default controls stay available while the account is offline. */
			});
		function changed(event: Event) {
			const scope = (event as CustomEvent).detail;
			if (scope.board === 'player' && scope.user === owner && scope.server === current.serverUrl) {
				loaded = loadLayout(current.serverUrl, owner, 'player');
			}
		}
		window.addEventListener('dn-layout-change', changed);
		return () => {
			live = false;
			window.removeEventListener('dn-layout-change', changed);
		};
	});
	let pending = $state(false);
	let sheet = $state<'more' | 'details' | 'equalizer' | 'lyrics' | 'signal' | 'suggestions' | null>(
		null
	);
	let sheetTrigger: HTMLElement | undefined;
	function openSheet(name: Exclude<typeof sheet, null>) {
		if (editor) return;
		if (!sheet)
			sheetTrigger =
				document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		sheet = name;
	}
	function toggleLyrics(section?: Section) {
		if (editor || !track) return;
		if (
			section?.lyricsMode === 'sheet' ||
			!(gridVisible ? sections : queueOpen ? rows[0] : rows.flat()).some(
				(s) => s.id === 'player-artwork'
			)
		)
			openSheet('lyrics');
		else artworkLyrics = !artworkLyrics;
	}
	function visitCredit(kind: Credit, control: HTMLElement) {
		if (!track || !oncredit) return;
		const source = sheet ? (sheetTrigger ?? control) : control;
		sheet = null;
		oncredit(kind, track, source);
	}
	let preview = $state<number | null>(null);
	const track = $derived($store.tracks[$store.index]);
	const upNext = $derived(new Set($store.upNext ?? []));
	const canShuffle = $derived(
		$store.shuffled || $store.tracks.length - $store.index - 1 - upNext.size >= 2
	);
	const duration = $derived($store.duration || track?.duration || 0);
	const art = $derived(
		track?.artworkUrl?.startsWith(session.serverUrl + '/')
			? track.artworkUrl.slice(session.serverUrl.length)
			: track?.artworkUrl
	);
	const stamp = (s: number) =>
		Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
	const fixedLayout = $derived(isPlayerGrid(sections));
	// An intentionally empty layout keeps the ordinary playback and queue controls reachable.
	const gridVisible = $derived(
		fixedLayout && !!track && !queueOpen && (!!editor || sections.some((s) => !isPlayerSlot(s.id)))
	);
	const rows = $derived(playerCanvas(fixedLayout ? [] : sections));
	// Combined controls in an imported layout share the tile's dimensions and use their own glyphs.
	function groupAction(section: Section, id: string, showLabel = false): Section | undefined {
		if (!section.grid) return;
		return { ...section, id: 'player-' + id, icon: undefined, labelName: undefined, showLabel };
	}
	const hasArtwork = (row: Section[]) => row.some((s) => s.id === 'player-artwork');
	const flushRows = $derived(rows.map((row) => row.every((s) => s.padding === 0)));
	const clock = $derived(preview ?? $store.position);
	const compact = $derived(expanded ? defaultMiniPlayer : readMiniPlayer(session));
	const secondaryId = $props.id();
	const secondary = $derived(
		compact.secondary === 'artist-album'
			? [track?.artist, track?.album].filter(Boolean).join(' · ')
			: compact.secondary === 'hidden'
				? ''
				: track?.[compact.secondary]
	);
	const libraryWindow = $derived($store.libraryWindow);
	const canGoNext = $derived(
		$store.index + 1 < $store.tracks.length ||
			!!libraryWindow?.more ||
			$store.repeat === 'all' ||
			($store.autoplay && $store.repeat === 'off')
	);
	const swipeAction = $derived(editor ? undefined : skip);
	const queueOffset = $derived(libraryWindow?.offset ?? 0);
	const queueNumbers = $derived.by(() => {
		const extras = new Set(libraryWindow?.extras);
		let position = queueOffset;
		return $store.tracks.map((_, index) => (extras.has(index) ? '+' : String(++position)));
	});
	const shuffleLabel = $derived(
		$store.shuffled
			? 'Restore original order'
			: libraryWindow
				? 'Shuffle loaded upcoming tracks'
				: 'Shuffle upcoming'
	);
	const fields = $derived({
		title: track?.title ?? '',
		artist: track?.artist ?? '',
		album: track?.album ?? '',
		elapsed: stamp(clock),
		duration: stamp(duration),
		remaining: stamp(Math.max(0, duration - clock)),
		position: queueNumbers[$store.index] ?? '',
		count: String(libraryWindow?.total ?? $store.tracks.length)
	});
	async function edit(call: () => Promise<void>) {
		if (pending || editor) return false;
		pending = true;
		try {
			await call();
			if (!$store.tracks.length) oncollapse();
			return true;
		} catch (error) {
			onerror(error);
			return false;
		} finally {
			pending = false;
		}
	}
	function action(call: () => Promise<void>) {
		if (!editor) void call().catch(onerror);
	}
	function skip(direction: 'previous' | 'next') {
		if (direction === 'previous' || canGoNext) action(player[direction]);
	}
</script>

{#snippet groupCredit(kind: Credit, value: string)}
	{#if oncredit && !editor && track && value}
		<button
			type="button"
			class="credit-link"
			aria-label={'Open ' + kind + ' ' + value}
			onclick={(e) => visitCredit(kind, e.currentTarget)}>{value}</button
		>
	{:else}{value}{/if}
{/snippet}
{#snippet previous(section?: Section)}
	<button
		class="skip player-control"
		aria-label={uiText('Previous track')}
		onclick={() => action(player.previous)}
	>
		<PlayerActionFace {section} glyph={SkipBack} size={28} label={uiText('Previous')} />
	</button>
{/snippet}
{#snippet toggle(section?: Section)}
	<button
		class="play player-control"
		aria-label={$store.playing ? uiText('Pause') : uiText('Play')}
		onclick={() => action(player.toggle)}
	>
		<PlayerActionFace
			{section}
			glyph={$store.playing ? Pause : Play}
			label={$store.playing ? uiText('Pause') : uiText('Play')}
			size={36}
			fill
			playback={$store.playing ? 'pause' : 'play'}
		/>
	</button>
{/snippet}
{#snippet nextTrack(section?: Section)}
	<button
		class="skip player-control"
		aria-label={uiText('Next track')}
		disabled={!canGoNext}
		onclick={() => action(player.next)}
	>
		<PlayerActionFace {section} glyph={SkipForward} size={28} label={uiText('Next')} />
	</button>
{/snippet}
{#snippet repeat(label: boolean, section?: Section)}
	<button
		class="repeat player-control"
		aria-label={'Repeat ' + $store.repeat + '. Change repeat mode'}
		aria-pressed={$store.repeat !== 'off'}
		onclick={() => action(player.cycleRepeat)}
	>
		<PlayerActionFace
			{section}
			glyph={$store.repeat === 'one' ? Repeat1 : Repeat}
			size={18}
			label={'Repeat ' + $store.repeat}
			defaultLabel={label}
		/>
	</button>
{/snippet}
{#snippet shuffle(label: boolean, section?: Section)}
	<button
		class="repeat player-control"
		aria-label={uiText(shuffleLabel)}
		aria-pressed={$store.shuffled}
		disabled={!canShuffle || pending}
		onclick={() => edit(player.shuffleUpcoming)}
	>
		<PlayerActionFace
			{section}
			glyph={Shuffle}
			size={18}
			label={uiText(shuffleLabel)}
			defaultLabel={label}
		/>
	</button>
{/snippet}
{#snippet compactButton(button: MiniButton)}
	{#if button === 'queue'}
		<button
			class="mini-control"
			data-mini-action="queue"
			aria-label={uiText('Open play queue')}
			onclick={ontogglequeue}
		>
			<PlayerActionFace glyph={ListMusic} label={uiText('Queue')} />
		</button>
	{:else if button === 'next' || button === 'previous'}
		<button
			class="mini-control"
			aria-label={button === 'next' ? uiText('Next track') : uiText('Previous track')}
			disabled={button === 'next' && !canGoNext}
			onclick={() => skip(button)}
		>
			<PlayerActionFace
				glyph={button === 'next' ? SkipForward : SkipBack}
				label={button === 'next' ? uiText('Next') : uiText('Previous')}
			/>
		</button>
	{/if}
{/snippet}
{#snippet field(section: Section, r: number, c: number)}
	{@const caption =
		usesFieldCaption(section.id) && section.showLabel
			? section.labelName?.trim() || sectionTitle(section)
			: ''}
	{@const staticControl =
		previewOnly && !isPlayerMetadata(section.id) && !sampleDetails.has(section.id)}
	<div
		class="player-section"
		class:editing-field={composing}
		role={staticControl && !isPlayerSlot(section.id) ? 'img' : undefined}
		aria-label={staticControl && !isPlayerSlot(section.id) ? sectionTitle(section) : undefined}
		class:active-field={editor?.selected === section.id}
		data-section-id={section.id}
		data-align={section.align ??
			(section.grid ? (isPlayerMetadata(section.id) ? 'start' : 'center') : undefined)}
		style:grid-column={section.grid ? section.grid.x + 1 + ' / span ' + section.grid.w : undefined}
		style:grid-row={section.grid ? section.grid.y + 1 + ' / span ' + section.grid.h : undefined}
		data-slot={isPlayerSlot(section.id) || undefined}
		data-padding={section.padding}
		style:--slot-height={section.minHeight === undefined ? undefined : section.minHeight + 'px'}
		data-lines={section.maxLines ? section.maxLines : undefined}
		style:--field-lines={section.maxLines}
		style:--reserved-lines={section.reserveLines ? (section.maxLines ?? 0) : 0}
		style:--cell-v-align={section.vAlign}
		style:--field-padding={section.padding === undefined ? undefined : section.padding + 'px'}
		data-text-size={section.textSize}
	>
		<div
			class="content"
			style:--art-caption-space={caption ? '1.5rem' : undefined}
			style:width={section.contentWidth
				? 'min(100%, max(44px, ' + section.contentWidth + '%))'
				: undefined}
			inert={composing || staticControl}
			aria-hidden={composing || staticControl ? true : undefined}
		>
			{#if caption && section.labelPosition === 'above'}<span class="field-caption">{caption}</span
				>{/if}
			{#if section.title && section.title !== caption && !isPlayerSlot(section.id) && !['player-more', 'player-lyrics', 'player-up-next'].includes(section.id)}<h2
				>
					{section.title}
				</h2>{/if}
			{#if isPlayerSlot(section.id)}
				<span class="empty-slot" aria-hidden="true"></span>
			{:else if isNavigation(section.id)}<div class="field-controls">
					<PlayerNavigationAction
						id={section.id}
						{section}
						{queueOpen}
						editing={!!editor}
						disabled={section.id === 'player-queue' && !track}
						onactivate={(id) => {
							if (editor) return;
							else if (id === 'player-close') oncollapse();
							else if (id === 'player-settings') onsettings?.();
							else ontogglequeue?.();
						}}
					/>
				</div>
			{:else if section.id === 'player-heading'}<PlayerMetadata
					{section}
					value={queueOpen ||
					!track ||
					sections.some((s) => ['player-track', 'player-title'].includes(s.id))
						? 'Now playing'
						: track.title}
				/>
			{:else if !track}<span class="unavailable-field" aria-label={sectionTitle(section)}>—</span>
			{:else if section.id === 'player-sleep'}<div class="field-controls">
					<SleepTimer {section} timer={$store.sleepTimer} sample={!!editor} />
				</div>
			{:else if section.id === 'player-artwork'}
				<div
					class="hero"
					class:compact={!section.preview}
					class:lyric-art={artworkLyrics && !editor}
					use:swipeTracks={artworkLyrics ? undefined : swipeAction}
				>
					{#if artworkLyrics && !editor}
						<PlayerLyrics
							{session}
							trackId={track.id}
							position={$store.position}
							playing={$store.playing}
							onseek={(p) => action(() => player.seek(p))}
						/>
					{:else if editor}<img class="sample-art" alt={uiText('Album artwork')} src={sampleArt} />
					{:else}<Cover {session} path={art} seed={track.album || track.id} />{/if}
				</div>
			{:else if section.id === 'player-track'}
				<div class="track-meta">
					<h1 class="lines">
						{#if editor}{track.title}{:else}<button
								class="credit-link"
								aria-label={uiFormat('Track details for {song}', {
									song: track.title
								})}
								onclick={() => openSheet('details')}>{track.title}</button
							>{/if}
					</h1>
					<p class="lines">{@render groupCredit('artist', track.artist)}</p>
					{#if section.preview && track.album}<small class="lines"
							>{@render groupCredit('album', track.album)}</small
						>{/if}
				</div>
			{:else if section.id === 'player-timeline' || section.id === 'player-seek'}
				<PlayerProgress
					{section}
					{session}
					{track}
					position={$store.position}
					{duration}
					playing={$store.playing}
					sample={!!editor}
					onpreview={(p) => (preview = p)}
					onseek={(p) => action(() => player.seek(p))}
				/>
			{:else if section.id === 'player-transport'}
				<div class="transport" data-part="transport" class:compact={!section.preview}>
					{@render previous(groupAction(section, 'previous'))}
					{@render toggle(groupAction(section, 'toggle'))}
					{@render nextTrack(groupAction(section, 'next'))}
				</div>
			{:else if section.id === 'player-modes'}
				<div class="modes">
					{@render repeat(section.preview, groupAction(section, 'repeat', section.preview))}
					{@render shuffle(section.preview, groupAction(section, 'shuffle', section.preview))}
				</div>
			{:else if isPlayerMetadata(section.id)}
				{@const credit =
					section.id === 'player-artist'
						? 'artist'
						: section.id === 'player-album'
							? 'album'
							: undefined}
				<svelte:element
					this={section.id === 'player-title' && !editor ? 'h1' : 'div'}
					class="metadata-wrap"
					aria-label={section.id === 'player-title' && !editor ? track.title : undefined}
				>
					<PlayerMetadata
						{section}
						openLabel={section.id === 'player-title'
							? 'Track details for ' + track.title
							: credit && track[credit]
								? 'Open ' + credit + ' ' + track[credit]
								: undefined}
						onopen={section.id === 'player-title' && !editor
							? () => openSheet('details')
							: credit && track[credit] && !editor && oncredit
								? (el) => visitCredit(credit, el)
								: undefined}
						value={isPlayerText(section.id)
							? formatPlayerText(section.template, fields)
							: section.id === 'player-title'
								? fields.title
								: section.id === 'player-artist'
									? fields.artist
									: fields.album}
					/>
				</svelte:element>
			{:else if section.id === 'player-elapsed' || section.id === 'player-duration' || section.id === 'player-remaining'}
				<p class="field-time">
					{section.id === 'player-elapsed'
						? fields.elapsed
						: section.id === 'player-duration'
							? fields.duration
							: fields.remaining}
				</p>
			{:else if section.id === 'player-previous' || section.id === 'player-next' || section.id === 'player-toggle' || section.id === 'player-repeat' || section.id === 'player-shuffle'}
				<div class="field-controls" class:compact={!section.preview}>
					{#if section.id === 'player-previous'}{@render previous(section)}
					{:else if section.id === 'player-next'}{@render nextTrack(section)}
					{:else if section.id === 'player-toggle'}{@render toggle(section)}
					{:else if section.id === 'player-repeat'}{@render repeat(false, section)}
					{:else}{@render shuffle(false, section)}{/if}
				</div>
			{:else if section.id === 'player-quality'}
				{#if editor}<PlayerQuality {track} sample />
				{:else}<button
						class="signal-button"
						aria-label={tr('Open signal path', '信号経路を開く')}
						onclick={() => openSheet('signal')}
						><PlayerQuality {track} quality={$store.quality} /></button
					>{/if}
			{:else if trackToolFields.some((f) => f.id === section.id)}{#key section.id + track.id}<TrackTools
						{section}
						{session}
						{track}
						title={sectionTitle(section)}
						startOpen={true}
						sample={!!editor}
						mode="field"
						fields={[section.id]}
					/>{/key}
			{:else if section.id === 'player-lyrics'}<div class="field-controls">
					<button
						class="icon-button player-action player-control"
						aria-label={uiText('Lyrics')}
						aria-pressed={artworkLyrics || sheet === 'lyrics'}
						onclick={() => toggleLyrics(section)}
						><PlayerActionFace {section} glyph={MicVocal} label={uiText('Lyrics')} /></button
					>
				</div>
			{:else if section.id === 'player-more'}<div class="field-controls">
					<button
						class="icon-button player-action player-control"
						aria-haspopup="dialog"
						aria-label={uiText('More actions')}
						onclick={() => openSheet('more')}
						><PlayerActionFace
							{section}
							glyph={EllipsisVertical}
							label={uiText('More actions')}
						/></button
					>
				</div>
			{:else if section.id === 'player-up-next'}
				<div class="up-next">
					<button
						class="text-button"
						onclick={ontogglequeue}
						aria-label={'Open play queue from ' + sectionTitle(section)}
					>
						<PlayerActionFace
							{section}
							glyph={ListMusic}
							size={18}
							label={sectionTitle(section)}
							defaultLabel
						/></button
					>
					{#if section.preview}
						{#each $store.tracks.slice($store.index + 1, $store.index + 4) as next, offset (next.id + ':' + offset)}
							<button
								class="up-track"
								onclick={() => action(() => player.skipTo($store.index + offset + 1))}
							>
								<strong>{next.title}</strong><small>{next.artist}</small>
							</button>
						{:else}<p>
								{libraryWindow?.more
									? uiText('Loading upcoming tracks…')
									: uiText('End of the queue.')}
							</p>{/each}
					{/if}
				</div>
			{/if}
			{#if caption && section.labelPosition !== 'above'}<span class="field-caption">{caption}</span
				>{/if}
		</div>
		{@render editor?.overlay?.(section, r, c)}
	</div>
{/snippet}
{#if expanded}
	<section
		class="now performance"
		class:sample={composing}
		class:grid-player={gridVisible}
		class:queue-page={queueOpen}
		class:empty-player={!track}
		data-part={previewOnly
			? 'draft-player'
			: composing
				? 'sample-player'
				: transient
					? 'player-preview'
					: 'now-playing'}
		aria-label={previewOnly ? 'Now Playing layout preview' : 'Now playing'}
	>
		{#if queueOpen && track}<h1 class="queue-heading">{uiText('Play queue')}</h1>{/if}
		<div class="player-frame" use:fitPlayer={!gridVisible && !queueOpen && !!track}>
			{#if gridVisible}
				<div
					class="fixed-grid"
					data-player-grid
					style:--grid-cols={GRID_COLUMNS}
					style:--grid-rows={GRID_ROWS}
				>
					{#each sections as section (section.id)}
						{@render field(section, section.grid!.y, section.grid!.x)}
					{/each}
					{@render editor?.gridOverlay?.()}
				</div>
			{:else}
				<div
					class="player-canvas"
					class:no-art={!rows.some(hasArtwork)}
					style:grid-template-rows={queueOpen || !track
						? 'auto'
						: rows.map((row) => (hasArtwork(row) ? 'minmax(0,1fr)' : 'auto')).join(' ')}
				>
					{#each rows as row, r (r === 0 ? 'header' : row[0].id)}
						{@const columns = playerColumns(row)}
						{#if r === 0 || (track && !queueOpen)}
							<svelte:element
								this={r === 0 ? 'header' : 'div'}
								class="row-group"
								class:art-row={hasArtwork(row)}
								class:player-header={r === 0}
								class:compact-header={r === 0 &&
									row.every(
										(s) =>
											![
												'player-artwork',
												'player-more',
												'player-track',
												'player-lyrics',
												'player-up-next'
											].includes(s.id) && (s.minHeight ?? 0) <= 96
									)}
								class:flush-edge={r > 0 && flushRows[r] && (r === 1 || flushRows[r - 1])}
							>
								{@render editor?.rowControls?.(r)}
								<div class="row-surface">
									<div
										class="player-row"
										class:composed={row.length > 1}
										data-part={r === 0 ? 'player-header-row' : 'player-row'}
										data-layout-row={composing ? r : undefined}
										data-player-row={composing && r > 0 ? r - 1 : undefined}
										style:min-height={Math.max(0, ...row.map((s) => s.minHeight ?? 0)) + 'px'}
										style:--row-gap={playerRowGap(row, r === 0)}
										style:grid-template-columns={columns
											.map(
												(col) =>
													`minmax(min(44px, calc(100% / ${columns.length})), ${col[0].width ?? 1}fr)`
											)
											.join(' ')}
									>
										{#each columns as column (column[0].id)}
											{@const sizing = fieldSizing(row, column)}
											<div
												class="player-column"
												class:single={column.length === 1}
												data-player-column
												style:grid-template-rows={column.length > 1 && hasArtwork(column)
													? column
															.map((field) =>
																field.id === 'player-artwork' ? 'minmax(0, 1fr)' : 'auto'
															)
															.join(' ')
													: undefined}
												style:--player-button-size={sizing.button + 'px'}
												style:--player-face-size={sizing.face + 'px'}
											>
												{#each column as section (section.id)}
													{@const c = row.indexOf(section)}
													{@render field(section, r, c)}
												{/each}
											</div>
										{/each}
									</div>
								</div>
								{#if r === 0 && !composing}<PlayerHeader
										readOnly={previewOnly}
										{row}
										{sections}
										{queueOpen}
										track={!!track}
										playing={$store.playing}
										onclose={oncollapse}
										onqueue={ontogglequeue}
										ontoggle={() => action(player.toggle)}
									/>{/if}
								{@render editor?.inspector?.(r)}
							</svelte:element>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
		{#if libraryWindow?.problem}
			<div role="status">
				<p>{libraryWindow.problem}</p>
				<button class="secondary" onclick={() => action(player.retryLibraryWindow)}
					>{uiText('Retry library queue')}</button
				>
			</div>
		{/if}

		{#if queueOpen && track}
			<div class="queue-tools">
				{#if $store.autoplay !== undefined}
					<button class="text-button" onclick={() => openSheet('suggestions')}
						>{tr('Similar tracks', '似た曲')}</button
					>
				{/if}
				{#if !rows[0].some((s) => s.id === 'player-sleep')}<SleepTimer
						queueControl
						timer={$store.sleepTimer}
					/>{/if}
				<button
					class="secondary player-control"
					aria-label={uiText(shuffleLabel)}
					aria-pressed={$store.shuffled}
					disabled={!canShuffle || pending}
					onclick={() => edit(player.shuffleUpcoming)}
					><PlayerActionFace
						glyph={Shuffle}
						size={19}
						label={uiText(shuffleLabel)}
						defaultLabel
					/></button
				>
				<button class="text-button" aria-pressed={editing} onclick={() => (editing = !editing)}
					>{editing ? uiText('Done') : uiText('Edit queue')}</button
				>
			</div>
			{#if $store.autoplayProblem}
				<div role="status">
					<p>{$store.autoplayProblem}</p>
					<button class="text-button" onclick={() => action(player.retryAutoplay)}
						>{uiText('Retry similar music')}</button
					>
				</div>
			{/if}
			{#if editing}<div class="queue-options">
					{#if $store.autoplay !== undefined}
						<label
							><input
								type="checkbox"
								checked={$store.autoplay}
								onchange={(event) => action(() => player.setAutoplay(event.currentTarget.checked))}
							/>
							{uiText('Autoplay similar library music')}</label
						>
					{/if}
					{#if $store.hasPreviousQueue}
						<button
							class="text-button"
							disabled={pending}
							onclick={() => edit(player.restorePreviousQueue)}
							>{uiText('Restore previous queue')}</button
						>
					{/if}
					<button class="text-button" onclick={() => (saveQueue = [...$store.tracks])}
						>{libraryWindow
							? uiText('Save loaded tracks to playlist')
							: uiText('Save queue to playlist')}</button
					>
					<button
						class="text-button"
						disabled={pending || ($store.index + 1 >= $store.tracks.length && !libraryWindow?.more)}
						onclick={() => edit(player.clearUpcoming)}>{uiText('Clear upcoming')}</button
					>
				</div>{/if}
			<div
				class="queue"
				class:scrolled={queueScrolled}
				data-gesture-scroll
				data-pull-dismiss
				data-part="play-queue"
				onscroll={(event) => (queueScrolled = event.currentTarget.scrollTop > 1)}
			>
				{#if libraryWindow}
					<p>
						{uiText('Tracks')}
						{queueOffset + 1}–{libraryWindow.loaded}
						{uiText('of')}
						{libraryWindow.total.toLocaleString()}
					</p>
					{#if editing}<p>
							{tr(
								`Removing or reordering original tracks keeps only the ${$store.tracks.length} tracks shown here.`,
								`元の曲を削除・並べ替えると、表示中の ${$store.tracks.length} 曲だけがキューに残ります。`
							)}
						</p>{/if}
				{/if}
				<ReorderList
					count={$store.tracks.length}
					offset={queueOffset}
					order={() => queueOrder($store)}
					move={(from, to, expected) => edit(() => player.move(from, to, expected))}
				>
					{#snippet children(grip)}
						<ol>
							{#each $store.tracks as item, i (item.id + ':' + i)}
								<li data-reorder-row={i}>
									{#if upNext.size && i > $store.index && (i === $store.index + 1 || upNext.has(i) !== upNext.has(i - 1))}
										<h3 class="queue-group-heading">
											{upNext.has(i)
												? tr('Up Next', '次の再生リスト')
												: tr('Continue original queue', '元のキューの続き')}
										</h3>
									{/if}
									<button
										class:current={i === $store.index}
										aria-current={i === $store.index ? 'true' : undefined}
										onclick={() => action(() => player.skipTo(i))}
									>
										{#if i === $store.index}<AudioLines size={18} />{:else}<span
												>{queueNumbers[i]}</span
											>{/if}
										<span><strong>{item.title}</strong><small>{item.artist}</small></span>
									</button>
									{#if editing}
										<div class="edit-tools">
											{#if i > $store.index && !upNext.has(i)}
												<button
													disabled={pending}
													aria-label={tr('Add to Up Next', '次の再生リストに追加') +
														' · ' +
														item.title}
													onclick={() => edit(() => player.prioritize(i, queueOrder($store)))}
													><ListPlus size={18} /></button
												>
											{/if}
											{@render grip(i, item.title, pending)}
											<button
												disabled={pending}
												aria-label={uiFormat('Remove {song} from queue', { song: item.title })}
												onclick={() => edit(() => player.remove(i))}><Minus size={18} /></button
											>
										</div>
									{/if}
								</li>
							{/each}
						</ol>
					{/snippet}
				</ReorderList>
			</div>
		{:else if !track}
			<h1>{uiText('Nothing playing')}</h1>
			<button class="secondary" onclick={oncollapse}>{uiText('Browse music')}</button>
		{/if}

		{#if $store.error}<p role="alert">{$store.error}</p>{/if}
	</section>
	{#if sheet && track && !editor}
		<PlayerSheet
			title={sheet === 'more'
				? uiText('More actions')
				: sheet === 'details'
					? uiText('Track details')
					: sheet === 'lyrics'
						? uiText('Lyrics')
						: sheet === 'suggestions'
							? tr('Similar tracks', '似た曲')
							: sheet === 'signal'
								? tr('Signal path', '信号経路')
								: uiText('Equalizer')}
			fullScreen={sheet === 'lyrics'}
			onclose={() => (sheet = null)}
		>
			{#if sheet === 'lyrics'}<PlayerLyrics
					{session}
					trackId={track.id}
					position={$store.position}
					playing={$store.playing}
					onseek={(p) => action(() => player.seek(p))}
				/>
			{:else if sheet === 'suggestions'}{#key session.serverUrl + ':' + (session.userId ?? '') + ':' + track.id}<AutoplaySuggestions
						{session}
						tracks={$store.tracks}
					/>{/key}
			{:else if sheet === 'signal'}<SignalPath
					{track}
					quality={$store.quality}
					delivery={$store.delivery}
				/>
			{:else if sheet === 'equalizer'}<EqualizerSettings />
			{:else if sheet === 'details'}{#key track.id}<TrackTools
						{session}
						{track}
						mode="details"
						artwork={art}
						playback={$store.quality}
						onsignal={() => openSheet('signal')}
						{duration}
						fields={[]}
					/>{/key}
			{:else}
				<div class="more-actions">
					<div class="song-summary"><strong>{track.title}</strong><span>{track.artist}</span></div>
					{#key track.id}<TrackTools
							{session}
							{track}
							mode="actions"
							fields={['player-favorite', 'player-playlist', 'player-download', 'player-rating']}
						/>{/key}
					<button class="sheet-action" onclick={() => openSheet('details')}
						><Info />{uiText('Track details')}</button
					>
					<button class="sheet-action" onclick={() => openSheet('signal')}
						><AudioLines />{tr('Signal path', '信号経路')}</button
					>
					{#if track.artist && oncredit}<button
							class="sheet-action"
							onclick={(e) => visitCredit('artist', e.currentTarget)}
							><UserRound />{uiText('Go to artist')}</button
						>{/if}
					{#if track.album && oncredit}<button
							class="sheet-action"
							onclick={(e) => visitCredit('album', e.currentTarget)}
							><Disc3 />{uiText('Go to album')}</button
						>{/if}
					<SleepTimer timer={$store.sleepTimer} />
					<SoundSettings speedOnly />
					{#if Capacitor.isNativePlatform()}<button
							class="sheet-action"
							onclick={() => openSheet('equalizer')}
							><SlidersHorizontal />{uiText('Equalizer')}</button
						>{/if}
					{#if onsettings}<button
							class="sheet-action"
							onclick={() => {
								sheet = null;
								onsettings?.();
							}}><SlidersHorizontal />{uiText('Edit player layout')}</button
						>{/if}
				</div>
			{/if}
		</PlayerSheet>
	{/if}
	{#if saveQueue}<AddToPlaylist
			{session}
			tracks={saveQueue}
			onclose={() => (saveQueue = null)}
		/>{/if}
{:else if track}
	<section data-part="mini-player" class="mini" aria-label={uiText('Current track')}>
		<button
			class="open-mini"
			use:swipeTracks={swipeAction}
			data-mini-action="player"
			onclick={onexpand}
			aria-label={uiFormat('Open player for {song}', { song: track.title })}
			aria-describedby={secondary ? secondaryId : undefined}
		>
			{#if compact.artwork}<span class="mini-art"
					><Cover {session} path={art} seed={track.album || track.id} /></span
				>{/if}
			<span class="mini-meta"
				><strong>{track.title}</strong>{#if secondary}<small id={secondaryId}>{secondary}</small
					>{/if}</span
			>
		</button>
		{@render compactButton(compact.before)}
		<button
			class="mini-control"
			aria-label={$store.playing ? uiText('Pause') : uiText('Play')}
			onclick={() => action(player.toggle)}
		>
			<PlayerActionFace
				glyph={$store.playing ? Pause : Play}
				label={$store.playing ? uiText('Pause') : uiText('Play')}
			/>
		</button>
		{@render compactButton(compact.after)}
		{#if compact.progress && Number.isFinite(duration) && duration > 0}
			<progress
				class="mini-progress"
				aria-label={uiText('Track progress')}
				max={duration}
				value={clock}
				aria-valuetext={stamp(clock) + ' of ' + stamp(duration)}
			></progress>
		{/if}
	</section>
{/if}

<style>
	.metadata-wrap {
		font: inherit;
		margin: 0;
		min-width: 0;
	}
	.player-column {
		min-width: 0;
		min-height: 0;
		display: grid;
		align-content: var(--cell-v-align, center);
		align-self: stretch;
	}
	.player-column.single {
		display: contents;
	}
	.player-canvas {
		display: grid;
		min-width: 0;
		gap: var(--gap);
	}
	.now.performance {
		height: var(--player-viewport-height, calc(100dvh - env(safe-area-inset-top)));
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 0;
		min-height: 0;
		overflow: hidden;
		padding-block: 0 max(0.25rem, env(safe-area-inset-bottom));
	}
	.performance .player-frame {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	.performance .player-canvas {
		height: calc(100% / var(--player-fit, 1));
		transform: scale(var(--player-fit, 1));
		transform-origin: top center;
		--player-row-space: min(var(--gap), 0.65dvh);
		gap: var(--player-row-space);
		align-content: stretch;
	}
	.performance .player-canvas.no-art {
		align-content: start;
	}
	.performance.queue-page .player-frame,
	.performance.empty-player .player-frame {
		flex: none;
	}
	.performance.queue-page .player-canvas,
	.performance.empty-player .player-canvas {
		height: auto;
	}
	.performance.queue-page .queue {
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		touch-action: pan-x pan-down pinch-zoom;
		flex: 1;
	}
	.performance.queue-page .queue.scrolled {
		touch-action: pan-x pan-y pinch-zoom;
	}
	.queue-heading {
		margin: 0;
		padding-block: 0.35rem;
		touch-action: pinch-zoom;
	}
	.performance.empty-player > h1 {
		margin: auto auto 0.75rem;
	}
	.performance.empty-player > button {
		align-self: center;
		margin-bottom: auto;
	}
	.performance .player-header {
		position: relative;
		min-height: 44px;
		z-index: 0;
	}
	.performance .flush-edge {
		margin-block-start: calc(0px - var(--player-row-space));
	}
	.performance .art-row,
	.performance .art-row .row-surface,
	.performance .art-row .player-row {
		height: 100%;
		min-height: 0;
	}
	.performance .art-row [data-section-id='player-artwork'] {
		min-height: 0;
		min-width: 0;
		container-type: size;
		align-content: center;
	}
	.performance .art-row .hero {
		width: min(100%, calc(100cqh - var(--art-caption-space, 0px)));
		min-width: 0;
		margin-block: 0;
	}
	.performance .art-row .hero.compact {
		width: min(100%, calc(100cqh - var(--art-caption-space, 0px)), 13rem);
	}
	.performance [data-section-id='player-title'] :global(.credit-link),
	.performance [data-section-id='player-artist'] :global(.credit-link),
	.performance [data-section-id='player-album'] :global(.credit-link) {
		min-block-size: max(24px, 1.3lh, calc(var(--reserved-lines, 0) * 1lh));
	}
	.performance [data-section-id] :global(.credit-link.icon-only) {
		min-block-size: max(44px, calc(var(--reserved-lines, 0) * 1lh));
	}
	@media (min-height: 700px) {
		.performance [data-section-id='player-title'] :global(.credit-link),
		.performance [data-section-id='player-artist'] :global(.credit-link),
		.performance [data-section-id='player-album'] :global(.credit-link) {
			min-block-size: max(44px, calc(var(--reserved-lines, 0) * 1lh));
		}
	}
	.hero {
		position: relative;
	}
	.hero:not(.lyric-art) {
		border-radius: var(--radius) var(--radius) 0 0;
		overflow: clip;
	}
	.hero:not(.lyric-art)::after {
		content: '';
		position: absolute;
		inset: 58% 0 -1px;
		pointer-events: none;
		background: linear-gradient(transparent, var(--bg));
	}
	.hero.lyric-art {
		display: flex;
		flex-direction: column;
		aspect-ratio: 1;
		max-height: 100%;
		overflow: hidden;
	}
	.more-actions {
		display: grid;
		gap: 0.45rem;
	}
	.song-summary {
		display: grid;
		gap: 0.15rem;
		padding: 0.2rem 0 0.7rem;
	}
	.song-summary span {
		color: var(--muted);
	}
	.sheet-action {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		min-height: 44px;
		text-align: left;
	}
	.sheet-action :global(svg) {
		width: 20px;
		height: 20px;
	}
	.player-action {
		width: min(100%, var(--player-button-size, 44px));
		min-height: 44px;
		justify-self: var(--cell-align, center);
	}
	:global(.preview-body) .performance {
		height: var(--player-viewport-height, calc(100dvh - 56px));
	}

	.field-caption {
		display: block;
		font-size: 0.8rem;
		line-height: 1.15;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.content {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		padding-block: var(--field-padding, 0px);
		padding-inline: min(var(--field-padding, 0px), max(0px, calc((100% - 44px) / 2)));
		max-width: 100%;
		margin-inline: var(--art-start, auto) var(--art-end, auto);
	}
	.row-surface,
	.row-group {
		min-width: 0;
	}
	.flush-edge {
		margin-block-start: calc(0px - var(--gap));
	}
	.player-section[data-padding] .hero {
		margin-block: 0;
	}
	.player-section[data-padding] .field-controls :global(button),
	.player-section[data-padding] .transport button,
	.player-section[data-padding] .modes button,
	.player-section[data-padding] .content :global(summary),
	.player-section[data-padding] .up-next > button {
		padding: 0;
		min-height: 44px;
	}
	.player-section[data-padding] .content :global(summary) {
		align-content: center;
	}
	.player-section[data-padding] .content > h2 {
		margin: 0;
	}

	.editing-field {
		container-type: inline-size;
		position: relative;
		min-height: 0;
		align-self: stretch;
		align-content: var(--cell-v-align, center);
		outline: 1px dashed var(--line);
		outline-offset: 2px;
		border-radius: var(--radius);
	}
	.active-field {
		outline: 2px solid var(--accent);
	}
	.sample-art {
		display: block;
		object-fit: cover;
		object-view-box: inset(7%);
		width: 100%;
		aspect-ratio: 1;
		border-radius: var(--radius);
	}

	.queue-options {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--gap);
		flex-wrap: wrap;
	}
	.player-row {
		display: grid;
		min-width: 0;
		align-items: center;
		gap: var(--row-gap, min(var(--gap), 3vw));
	}
	.lines {
		min-block-size: calc(var(--reserved-lines, 0) * 1lh);
	}
	.player-section[data-lines] .lines {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: var(--field-lines);
		line-clamp: var(--field-lines);
		overflow: hidden;
	}
	.empty-slot {
		display: block;
		min-height: var(--slot-height, 44px);
	}
	.player-section {
		display: grid;
		align-self: stretch;
		align-content: var(--cell-v-align, center);

		min-width: 0;
		overflow-wrap: anywhere;
		--cell-scale: 1;
		font-size: calc(1rem * var(--cell-scale));
		text-align: var(--cell-align, start);
	}
	.player-section[data-align='start'] {
		--cell-justify: flex-start;
		--cell-align: start;
		--art-start: 0;
		--art-end: auto;
	}
	.player-section[data-align='center'] {
		--cell-justify: center;
		--cell-align: center;
		--art-start: auto;
		--art-end: auto;
	}
	.player-section[data-align='end'] {
		--cell-justify: flex-end;
		--cell-align: end;
		--art-start: auto;
		--art-end: 0;
	}
	.player-section[data-text-size='small'] {
		--cell-scale: 0.82;
	}
	.player-section[data-text-size='large'] {
		--cell-scale: 1.35;
	}
	.field-time {
		margin: 0;
		overflow-wrap: anywhere;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.field-controls {
		display: flex;
		align-items: center;
		justify-content: var(--cell-justify, center);
	}
	.field-controls button {
		min-width: 44px;
		min-height: 44px;
		max-width: 100%;
	}
	.composed .transport {
		--transport-gap: min(0.35rem, 1vw);
	}
	.composed .modes {
		column-gap: min(0.4rem, 1vw);
	}
	.composed .repeat {
		flex-wrap: wrap;
		justify-content: center;
		max-width: 100%;
	}
	.composed .up-next .text-button {
		flex-wrap: wrap;
	}
	.player-section :global(details) {
		min-width: 0;
		max-width: 100%;
	}
	.composed .player-section :global(.secondary) {
		max-width: 100%;
		overflow-wrap: anywhere;
		padding-inline: min(0.8em, 8%);
	}

	.player-section h2 {
		font-size: 1em;
		margin: 0 0 0.4rem;
	}
	.hero.compact {
		width: min(45%, 13rem);
		min-width: 0;
	}
	.transport.compact .play,
	.field-controls.compact .play {
		--preferred-play: 48px;
	}
	.modes {
		display: flex;
		align-items: center;
		justify-content: var(--cell-justify, center);
		gap: var(--gap);
		flex-wrap: wrap;
	}
	.up-next,
	.up-track {
		display: grid;
	}
	.up-next .text-button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		justify-content: var(--cell-justify, space-between);
		font-weight: 600;
	}
	.up-track {
		text-align: var(--cell-align, start);
		min-height: 44px;
		align-content: center;
	}
	.up-next p {
		color: var(--muted);
	}
	.now {
		container-type: inline-size;
		max-width: 32rem;
		width: 100%;
		margin: auto;
		padding: 0 min(var(--gap), 5vw) max(1.5rem, env(safe-area-inset-bottom));
		grid-template-columns: minmax(0, 1fr);
		display: grid;
		gap: var(--gap);
		align-content: start;
	}
	.player-header {
		position: relative;
		top: 0;
		z-index: 1;
		align-self: start;
		min-height: 3.8rem;
		display: grid;
		align-content: center;
		background: var(--bg);
	}
	.compact-header {
		position: sticky;
	}
	.sample .player-header {
		position: relative;
		top: auto;
		z-index: 0;
	}
	.unavailable-field {
		color: var(--muted);
		text-align: center;
		display: block;
	}

	.hero {
		width: min(100%, 52dvh);
		min-width: min(100%, 10rem);
		margin-block: clamp(0.2rem, 2vh, 2rem);
		margin-inline: var(--art-start, auto) var(--art-end, auto);
	}
	.credit-link {
		color: inherit;
		font: inherit;
		text-align: inherit;
		padding: 0;
		min-height: 44px;
		min-width: min(44px, 100%);
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.credit-link:hover,
	.credit-link:focus-visible {
		text-decoration: underline;
	}
	.track-meta h1,
	.track-meta p {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.track-meta h1 {
		font-size: calc(clamp(1.75rem, 7vw, 2.45rem) * var(--cell-scale));
	}
	.track-meta p {
		font-size: 1.15em;
	}
	small {
		color: var(--muted);
	}
	.transport {
		display: flex;
		justify-content: var(--cell-justify, center);
		flex-wrap: wrap;
		align-items: center;
		--transport-gap: clamp(0.8rem, 6vw, 3rem);
		gap: var(--transport-gap);
	}
	.skip,
	.play,
	.mini-control {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
	}
	.skip {
		width: min(100%, max(48px, var(--player-button-size, 0px)));
		height: auto;
		aspect-ratio: 1;
	}
	.transport > button {
		max-width: max(44px, calc((100% - 2 * var(--transport-gap)) / 3));
	}
	.play {
		border-radius: 50%;
		width: min(100%, max(var(--preferred-play, 4.5rem), var(--player-button-size, 0px)));
		height: auto;
		aspect-ratio: 1;
		min-width: 44px;
		min-height: 44px;
	}
	.queue ol {
		list-style: none;
		padding: 0;
	}
	.queue-tools,
	.edit-tools,
	.queue li,
	.repeat {
		display: flex;
		align-items: center;
	}
	.queue-tools {
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.repeat {
		gap: 0.4rem;
		justify-self: center;
		min-width: 44px;
		min-height: 44px;
	}
	.edit-tools button {
		min-width: 44px;
		min-height: 44px;
	}
	.queue li {
		border-bottom: 1px solid var(--line);
		flex-wrap: wrap;
	}
	.queue-group-heading {
		flex-basis: 100%;
		margin: 0.8rem 0 0;
		color: var(--accent);
		font-size: 0.9rem;
	}
	.signal-button {
		display: inline-flex;
		align-items: center;
		justify-content: inherit;
		max-width: 100%;
		min-height: 40px;
		padding: 0;
	}
	.queue li > button {
		display: flex;
		width: 100%;
		gap: var(--gap);
		align-items: center;
		text-align: start;
		padding: 0.5rem 0;
		min-height: 3.6rem;
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.queue li > button > span:first-child {
		min-width: 1.1rem;
		text-align: center;
	}
	.queue strong,
	.queue small,
	.mini-meta > * {
		display: block;
	}
	.queue .current {
		color: var(--accent);
	}
	.mini {
		position: relative;
		display: flex;
		align-items: center;
		margin: 0.3rem var(--gap);
		padding: 0.3rem;
		border-radius: var(--radius);
		background: var(--raised);
	}
	.open-mini {
		display: flex;
		text-align: start;
		gap: 0.7rem;
		align-items: center;
		min-width: 0;
		min-height: 44px;
		flex: 1;
	}
	.mini-progress {
		pointer-events: none;
		position: absolute;
		inset: auto 0.55rem 0;
		width: calc(100% - 1.1rem);
		height: 2px;
		border: 0;
		border-radius: 1px;
		overflow: hidden;
		appearance: none;
		background: var(--line);
		color: var(--accent);
	}
	.mini-progress::-webkit-progress-bar {
		background: var(--line);
	}
	.mini-progress::-webkit-progress-value {
		background: var(--accent);
	}
	.mini-progress::-moz-progress-bar {
		background: var(--accent);
	}
	.mini-art {
		width: 46px;
		flex-shrink: 0;
	}
	.mini-control {
		flex-shrink: 0;
		width: 44px;
	}
	.mini-meta {
		min-width: 0;
	}
	.mini-meta > * {
		text-overflow: ellipsis;
		overflow: hidden;
		white-space: nowrap;
	}

	.performance.grid-player {
		padding-inline: 0;
	}
	.fixed-grid {
		display: grid;
		position: relative;
		height: 100%;
		width: 100%;
		grid-template-columns: repeat(var(--grid-cols), minmax(0, 1fr));
		grid-template-rows: repeat(var(--grid-rows), minmax(0, 1fr));
	}
	.fixed-grid > .player-section {
		position: relative;
		container-type: size;
		min-width: 0;
		min-height: 0;
		grid-template-columns: minmax(0, 1fr);
		outline-offset: -1px;
		border-radius: 0;
	}
	.fixed-grid .content {
		overflow: clip;
		padding: var(--field-padding, 0px);
		max-height: 100cqh;
	}
	.fixed-grid .field-controls :global(button) {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 0;
		min-width: min(44px, 100%);
		min-height: min(44px, calc(100cqh - 2 * var(--field-padding, 0px)));
		width: fit-content;
		height: auto;
		aspect-ratio: auto;
		max-width: 100%;
	}
	.fixed-grid [data-section-id='player-artwork'] .hero {
		margin-block: 0;
		width: 100%;
		min-width: 0;
		height: max(0px, calc(100cqh - 2 * var(--field-padding, 0px) - var(--art-caption-space, 0px)));
	}
	.fixed-grid .hero :global(.cover),
	.fixed-grid .sample-art {
		width: 100%;
		height: 100%;
		aspect-ratio: auto;
		border-radius: inherit;
	}
	.fixed-grid .transport,
	.fixed-grid .modes,
	.fixed-grid .content :global(.stars) {
		--grid-group-count: 3;
		display: flex;
		flex-wrap: nowrap;
		gap: 0;
	}
	.fixed-grid .modes {
		--grid-group-count: 2;
	}
	.fixed-grid .content :global(.stars) {
		--grid-group-count: 5;
	}
	.fixed-grid .transport button,
	.fixed-grid .modes button,
	.fixed-grid .content :global(.stars button) {
		width: auto;
		min-width: min(44px, calc(100% / var(--grid-group-count)));
		max-width: calc(100% / var(--grid-group-count));
		height: auto;
		aspect-ratio: auto;
		justify-content: center;
	}
	.fixed-grid .content :global(.stars button) {
		display: grid;
		place-items: center;
		min-height: clamp(0px, calc(100cqh - 2 * var(--field-padding, 0px)), 44px);
		padding: 0;
	}

	.performance .fixed-grid [data-section-id] :global(.credit-link),
	.fixed-grid .signal-button {
		min-block-size: 0;
	}
	.fixed-grid [data-section-id='player-title'] :global(.field-title) {
		font-size: calc(clamp(1.19rem, 6.5cqw, 1.56rem) * var(--cell-scale));
		font-weight: 700;
		letter-spacing: -0.035em;
		line-height: 1.1;
	}
</style>
