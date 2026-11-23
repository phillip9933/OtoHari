<script lang="ts">
	import { tr, uiText } from '../i18n';
	import { Tags, EllipsisVertical } from '@lucide/svelte';
	import type { Session } from '../connection';
	import type { OfflineInventory } from '../offline/library';
	import type { BrowseItem, Category } from './libraryBrowse';
	import { browseChoice } from './libraryBrowse';
	import { tick, type Snippet } from 'svelte';
	import { browseViewport, initialWindow } from './browseViewport';
	import { useLibrarySelection } from './librarySelection.svelte';
	import PlaylistCover from './PlaylistCover.svelte';
	import Cover from './Cover.svelte';
	import { originIndex, itemOrigins } from './libraryOrigins';
	import { trackStatusLabels, trackStatusIcons, type TrackStatus } from './trackStatus';
	import TrackActions from './TrackActions.svelte';
	let {
		session,
		items,
		category,
		layout,
		columns,
		albumGallery = false,
		numbered = false,
		label,
		compact = false,
		active = true,
		inventory,
		total,
		localOnly = false,
		cacheOnly = localOnly,
		showOnlineOnly = false,
		open,
		endAction,
		menu
	}: {
		session: Session;
		items: BrowseItem[];
		category: Category;
		layout: 'list' | 'grid';
		columns: number;
		albumGallery?: boolean;
		numbered?: boolean;
		label?: string;
		compact?: boolean;
		active?: boolean;
		inventory?: OfflineInventory;
		total?: number;
		localOnly?: boolean;
		cacheOnly?: boolean;
		showOnlineOnly?: boolean;
		open?: (item: BrowseItem, index: number) => void;
		endAction?: Snippet<[number]>;
		menu?: (item: BrowseItem) => void;
	} = $props();
	const view = $props.id();
	const selectable = useLibrarySelection();
	const storage = $derived(originIndex(session, inventory));
	const status = $derived.by(() => {
		if (!storage.size && !(showOnlineOnly && inventory)) return;
		return new Map<string, TrackStatus[]>(
			items.map((item) => {
				const origins = itemOrigins(item, storage);
				return [
					item.id,
					origins.length ? ['offline'] : item.track && showOnlineOnly ? ['online'] : []
				];
			})
		);
	});
	const present = $derived([...new Set([...(status?.values() ?? [])].flat())]);
	let element: HTMLDivElement,
		metrics = $state.raw(initialWindow),
		pinned = $state(-1),
		anchor = $state(-1);
	const cols = $derived(layout === 'grid' ? columns : 1);
	// Discography selection ranges use all mounted album cards as their ordered collection.
	const virtual = $derived(!albumGallery && items.length > 64 && metrics.pitch > 0);
	const mounted = $derived.by(() => {
		const start = virtual ? metrics.start : 0,
			end = virtual ? metrics.end : items.length;
		const rows = items.slice(start, end).map((item, i) => ({ item, index: start + i }));
		if (virtual) {
			for (const extra of new Set([pinned, anchor])) {
				if (items[extra] && (extra < start || extra >= end))
					rows.push({ item: items[extra], index: extra });
			}
			rows.sort((a, b) => a.index - b.index);
		}
		return rows;
	});
	function focusNavigation(node: HTMLElement) {
		const events = new AbortController(),
			opts = { signal: events.signal };
		node.addEventListener('focusin', rememberFocus, opts);
		node.addEventListener(
			'dn-selection-anchor',
			(e) => {
				const item = (e.target as HTMLElement).closest<HTMLElement>('[data-browse-index]');
				anchor = (e as CustomEvent<boolean>).detail && item ? Number(item.dataset.browseIndex) : -1;
			},
			opts
		);
		node.addEventListener(
			'focusout',
			(e) => {
				if (node.contains(e.relatedTarget as Node | null)) return;
				// Removing a focused row can fire focusout during Svelte's DOM update.
				queueMicrotask(() => {
					if (!events.signal.aborted && !node.contains(document.activeElement)) pinned = -1;
				});
			},
			opts
		);
		node.addEventListener('keydown', keyboard, opts);
		return {
			destroy() {
				events.abort();
			}
		};
	}

	export async function focusItem(id: string) {
		const index = items.findIndex((i) => i.id === id);
		if (index < 0) return;
		pinned = index;
		await tick();
		element
			?.querySelector<HTMLButtonElement>('[data-browse-index="' + index + '"] .item')
			?.focus({ preventScroll: true });
	}
	export async function scrollToIndex(index: number) {
		if (!items[index]) return;
		pinned = index;
		await tick();
		element
			?.querySelector('[data-browse-index="' + index + '"]')
			?.scrollIntoView({ block: 'start', behavior: 'instant' });
	}
	function rememberFocus(e: FocusEvent) {
		const entry = (e.target as HTMLElement).closest<HTMLElement>('[data-browse-index]');
		pinned = entry ? Number(entry.dataset.browseIndex) : -1;
	}
	async function keyboard(e: KeyboardEvent) {
		if (!virtual || e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
		const target = e.target as HTMLElement,
			entry = target.closest<HTMLElement>('[data-browse-index]');
		if (!entry) return;
		const controls = entry.querySelectorAll<HTMLElement>('button:not([disabled])');
		if (target !== (e.shiftKey ? controls[0] : controls[controls.length - 1])) return;
		const next = Number(entry.dataset.browseIndex) + (e.shiftKey ? -1 : 1);
		if (
			next < 0 ||
			next >= items.length ||
			element.querySelector('[data-browse-index="' + next + '"]')
		)
			return;
		e.preventDefault();
		pinned = next;
		await tick();
		const nextControls = element.querySelectorAll<HTMLElement>(
			'[data-browse-index="' + next + '"] button:not([disabled])'
		);
		nextControls[e.shiftKey ? nextControls.length - 1 : 0]?.focus();
	}
</script>

{#snippet badge(origins: TrackStatus[], id: string)}
	{@const label = origins.map((origin) => uiText(trackStatusLabels[origin])).join(tr(', ', '、'))}
	<span {id} class="offline" role="img" title={label} aria-label={label}
		>{#each origins as origin (origin)}{@const Glyph = trackStatusIcons[origin]}<Glyph
				size={14}
			/>{/each}</span
	>
{/snippet}

{#if present.length}<div
		class="legend"
		aria-label={showOnlineOnly
			? uiText('Track availability')
			: tr('Offline availability', 'オフラインでの利用状況')}
		role="group"
	>
		{#each present as value (value)}{@const Glyph = trackStatusIcons[value]}<span
				><Glyph size={13} />{uiText(trackStatusLabels[value])}</span
			>{/each}
	</div>{/if}
<div class="browse-width">
	<div
		bind:this={element}
		use:browseViewport={{
			count: items.length,
			columns: cols,
			compact,
			active: active && !albumGallery,
			layout,
			onwindow: (w) => (metrics = w)
		}}
		class:windowed={virtual}
		style:height={virtual
			? Math.max(0, Math.ceil(items.length / cols) * metrics.pitch - metrics.gap) + 'px'
			: undefined}
		style:--cell-width={metrics.width + 'px'}
		use:focusNavigation
		role="list"
		aria-label={label ?? tr(category + ' results', uiText(category) + 'の一覧')}
		data-part={albumGallery ? 'album-grid' : 'category-items'}
		data-loaded={items.length}
		data-layout={layout}
		data-columns={layout === 'grid' ? columns : 1}
		class:grid={layout === 'grid'}
		class:compact
		class="entries"
		style:--cols={columns}
		style:--column-intervals={Math.max(1, columns - 1)}
	>
		{#each mounted as { item, index } (item.id)}
			{@const origins = status?.get(item.id) ?? []}
			{@const badgeId = view + '-offline-' + index}
			{@const moreLabel = tr(
				'More options for ' + item.title,
				'「' + item.title + '」のその他の操作'
			)}
			<div
				class="entry"
				data-browse-index={index}
				role="listitem"
				aria-posinset={index + 1}
				aria-setsize={total ?? items.length}
				style:--entry-top={Math.floor(index / cols) * metrics.pitch + 'px'}
				style:--entry-left={(index % cols) * (metrics.width + metrics.columnGap) + 'px'}
				class:artist={category === 'Artists'}
				class:playlist={category === 'Playlists'}
				class:genre={category === 'Genres'}
			>
				{#snippet face()}
					{#if numbered && layout === 'list' && item.track}<span class="number"
							>{item.track.trackNumber || index + 1}</span
						>
					{:else}<span class="visual">
							<span class="art" class:round={category === 'Artists'}>
								{#if category === 'Genres'}<Tags size={23} />
								{:else if category === 'Playlists'}<PlaylistCover
										{session}
										id={item.id}
										covers={item.covers}
										{cacheOnly}
									/>
								{:else}<Cover
										{session}
										{cacheOnly}
										path={item.art}
										fallback={item.fallbackArt}
										seed={item.id}
									/>{/if}
							</span>
							{#if layout === 'grid' && origins.length}{@render badge(origins, badgeId)}{/if}
						</span>
					{/if}
					<span class="meta"
						><strong>{item.title}</strong
						>{#if item.subtitle && !(category === 'Artists' && layout === 'grid')}<small
								>{item.subtitle}</small
							>{/if}</span
					>
					{#if layout === 'list' && origins.length}{@render badge(origins, badgeId)}{/if}
				{/snippet}
				{#if open}
					<button
						class="item"
						data-part={albumGallery ? 'album-card' : undefined}
						aria-label={item.track
							? tr('Play ' + item.title, '「' + item.title + '」を再生')
							: albumGallery
								? undefined
								: item.title}
						aria-describedby={origins.length ? badgeId : undefined}
						onclick={() => open?.(item, index)}
						use:selectable={browseChoice(session, item)}
						>{@render face()}
					</button>{:else}<div class="item">{@render face()}</div>{/if}
				{#if endAction}<div class="more recording-action">
						{@render endAction(index)}
					</div>{:else if item.track}
					<span class="more"
						><TrackActions
							{session}
							{localOnly}
							vertical
							tracks={[item.track]}
							deviceAvailable={inventory || showOnlineOnly
								? !!inventory?.byId.has(item.track.id)
								: undefined}
							label={moreLabel}
							favorite={item.track.favorite}
						/></span
					>
				{:else if menu && (category === 'Genres' || category === 'Playlists' || layout === 'list')}
					<button class="more icon" aria-label={moreLabel} onclick={() => menu?.(item)}
						><EllipsisVertical size={18} /></button
					>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.browse-width {
		container-type: inline-size;
	}
	.entries.windowed {
		display: block;
		position: relative;
		overflow-anchor: none;
	}
	.entries.windowed .entry {
		position: absolute;
		inset-inline-start: var(--entry-left);
		inset-block-start: var(--entry-top);
		width: var(--cell-width);
	}
	.grid .entry:not(.artist):not(.genre) .meta {
		min-height: calc(1.3em + 1.118rem + 2 * var(--meta-padding));
	}

	.entries {
		display: grid;
		gap: 1px;
		min-width: 0;
	}
	.entries.grid {
		--meta-padding: 0.28rem;
		--grid-gap: 0.35rem;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		row-gap: 0.68rem;
		column-gap: clamp(
			0px,
			calc((100cqw - 44px * var(--cols)) / var(--column-intervals)),
			var(--grid-gap)
		);
	}
	.entries.grid.compact {
		--meta-padding: 0.08rem;
		--grid-gap: 0.2rem;
		row-gap: 0.25rem;
	}
	.grid .entry {
		container: browse-cell / inline-size;
	}
	.visual {
		display: block;
		position: relative;
		flex: none;
	}
	.compact:not(.grid) {
		row-gap: 0;
	}
	.compact:not(.grid) .item {
		min-height: 44px;
		padding-block: 0.1rem;
		gap: 0.4rem;
	}
	.entry {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.22rem;
		min-width: 0;
	}
	.item {
		padding: 0.2rem 0;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
		min-height: 48px;
		flex: 1;
		text-align: start;
	}
	.art {
		width: 3.05rem;
		height: 3.05rem;
		display: grid;
		place-items: center;
		flex: none;
		overflow: hidden;
		border-radius: var(--radius);
		color: var(--muted);
	}
	.art > :global(.cover) {
		width: 100%;
		height: 100%;
		border-radius: 0;
	}
	.art.round {
		border-radius: 50%;
	}
	.playlist .art {
		background: var(--surface);
	}
	.meta {
		display: grid;
		min-width: 0;
		text-align: start;
	}
	.meta strong,
	.meta small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 500;
		line-height: 1.3;
	}
	.meta small {
		color: var(--muted);
		font-size: 0.86rem;
		font-weight: 400;
	}
	.more {
		flex: none;
		display: grid;
		place-items: center;
	}
	.number {
		min-width: 2.15em;
		text-align: center;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
	.recording-action {
		min-width: 0;
		max-width: 50%;
		overflow-wrap: anywhere;
	}
	.grid .more.recording-action {
		position: static;
		width: 100%;
		max-width: 100%;
		background: transparent;
	}
	.icon {
		min-width: 44px;
		min-height: 44px;
	}
	.grid .entry,
	.grid .item {
		display: block;
	}
	.grid .item {
		padding: 0;
	}
	.grid .art {
		width: 100%;
		height: auto;
		aspect-ratio: 1;
	}
	.grid .meta {
		padding: var(--meta-padding) 0.2rem;
	}
	.grid .artist .meta {
		text-align: center;
	}
	.grid .more {
		position: absolute;
		inset-inline-end: 0.15rem;
		bottom: 2.6rem;
		border-radius: 50%;
		color: var(--text);
		background: var(--surface);
	}
	.grid .offline {
		position: absolute;
		top: 0.25rem;
		inset-inline-start: 0.25rem;
		max-width: calc(100% - 0.5rem);
		border-radius: 999px;
		background: var(--surface);
		padding: 0.15rem;
	}
	.grid .offline :global(svg) {
		min-width: 0;
	}
	@container browse-cell (max-width: 94px) {
		/* Give artwork and its menu independent touch targets when they cannot fit side by side. */
		.grid .more {
			position: static;
			width: 100%;
			background: transparent;
		}
		.grid .more :global(.bare-dots) {
			width: 100%;
		}
		.grid .offline {
			top: auto;
			bottom: 1px;
			inset-inline-start: 50%;
			transform: translateX(-50%);
			max-width: calc(100% - 2px);
			gap: 1px;
			padding: 1px 2px;
		}
		.grid .offline :global(svg) {
			width: 12px;
			height: 12px;
		}
	}
	.offline {
		display: inline-flex;
		align-items: center;
		gap: 0.16rem;
		color: var(--accent);
	}
	.legend,
	.legend span {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.legend {
		gap: 0.5rem;
		flex-wrap: wrap;
		margin: 0 0 0.45rem;
		color: var(--muted);
		font-size: 0.73rem;
	}
	.legend :global(svg) {
		color: var(--accent);
	}
	.genre .art {
		width: 2.65rem;
	}
	.grid .genre .art {
		width: 100%;
	}
	.compact:not(.grid) .art {
		width: 2.45rem;
		height: 2.45rem;
	}
</style>
