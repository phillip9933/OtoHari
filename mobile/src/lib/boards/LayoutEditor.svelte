<script lang="ts">
	import { pageTitles } from '../appearance/settingsSearch';
	import { tr, uiText, uiFormat } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import CollectionDisplayFields from '../catalog/CollectionDisplayFields.svelte';
	import { categories, type Category } from '../catalog/libraryBrowse';
	import { readBrowsePreferences, type CollectionEdits } from '../catalog/browsePreferences';
	import type { Session } from '../connection';
	import { tick, untrack } from 'svelte';
	import {
		getVisibility,
		saveVisibility,
		sharedSection,
		type SectionPrefs
	} from './sectionVisibility';
	import { boardDisplay } from './display';
	import FilterSectionDialog from './FilterSectionDialog.svelte';
	import { filterSummary, type FilterSection } from './filteredSections';
	import { ArrowUp, ArrowDown, Minus, Plus, SlidersHorizontal } from '@lucide/svelte';
	import { available, defaults, sectionTitle, type Board, type Section } from './layout';
	let {
		board,
		session,
		sections,
		filters,
		onsave,
		onback
	}: {
		board: Board;
		session: Session;
		filters: FilterSection[];
		sections: Section[];
		onsave: (items: Section[], filters?: FilterSection[], pages?: CollectionEdits) => void;
		onback: () => void;
	} = $props();
	function editable(section: Section): Section {
		return { ...section, display: boardDisplay(section.id, section.display, section.filter?.kind) };
	}
	let draft = $state<Section[]>(untrack(() => sections.map(editable)));
	let saved = $state<FilterSection[]>(untrack(() => filters.slice())),
		editing = $state<Partial<FilterSection> | null>(null);
	let options = $state('');
	let editingPages = $state(false);
	let page = $state<Category>('Albums');
	let pageEdits = $state<CollectionEdits>({});
	const pageDisplay = $derived({ ...readBrowsePreferences(session, page), ...pageEdits[page] });
	let filter = $state('');
	let error = $state('');
	let list: HTMLOListElement;
	let prefs = $state.raw<SectionPrefs>();
	let toggles = $state<Record<string, boolean>>({});
	let loadingError = $state('');
	let saving = $state(false);
	let retry = $state(0);
	$effect(() => {
		const account = session;
		void retry;
		prefs = undefined;
		toggles = {};
		loadingError = '';
		if (board === 'library') return;
		const job = new AbortController();
		void getVisibility(account, job.signal)
			.then((result) => {
				if (!job.signal.aborted) prefs = result;
			})
			.catch(() => {
				if (!job.signal.aborted)
					loadingError = tr(
						'Account visibility is unavailable. You can still edit the layout on this device.',
						'アカウントの表示設定を取得できません。この端末のレイアウトは編集できます。'
					);
			});
		return () => job.abort();
	});
	function setVisibility(key: string, enabled: boolean, original: boolean) {
		const next = { ...toggles };
		if (enabled === original) delete next[key];
		else next[key] = enabled;
		toggles = next;
	}

	const choices = $derived(
		[
			...available(board).map((w) => ({ ...w, label: uiText(w.label) })),
			...(board === 'discover' ? [] : saved.map((f) => ({ id: f.id, label: f.name })))
		].filter(
			(w) =>
				!draft.some((s) => s.id === w.id) &&
				w.label.toLowerCase().includes(filter.trim().toLowerCase())
		)
	);
	function move(index: number, target: number) {
		const next = [...draft];
		const [item] = next.splice(index, 1);
		next.splice(target, 0, item);
		draft = next;
	}
	async function add(id: string) {
		editingPages = false;
		draft = [
			...draft,
			editable({ id, title: '', preview: true, filter: saved.find((f) => f.id === id) })
		];
		options = id;
		await tick();
		const row = list.querySelector<HTMLElement>('[data-section-id="' + CSS.escape(id) + '"]');
		row?.querySelector<HTMLButtonElement>('[aria-expanded]')?.focus({ preventScroll: true });
		row?.scrollIntoView({ block: 'center' });
	}
	async function save() {
		if (saving) return;
		saving = true;
		error = '';
		try {
			if (board !== 'library' && Object.keys(toggles).length) {
				prefs = await saveVisibility(session, board, toggles);
				toggles = {};
			}
		} catch (reason) {
			error =
				reason instanceof Error
					? reason.message
					: tr(
							'Could not save account visibility.',
							'アカウントの表示設定を保存できませんでした。'
						);
			saving = false;
			return;
		}
		try {
			onsave(
				draft,
				board === 'discover' ? undefined : saved,
				board === 'library' ? pageEdits : undefined
			);
		} catch {
			error = 'Could not save this layout on the device. Your edits are still here.';
		} finally {
			saving = false;
		}
	}
</script>

<div class="editor" data-part="layout-editor" inert={saving}>
	<div class="bar">
		<button class="text-button" disabled={saving} onclick={onback}>{uiText('Cancel')}</button>
		<button class="primary" disabled={saving} onclick={save}>{uiText('Save layout')}</button>
	</div>
	<h1>{uiText(pageTitles[board])}</h1>
	<p>{uiText('Layout on this device')}</p>
	{#if board !== 'library' && prefs?.pages[board]?.length}<p>
			{tr(
				'Shared sections have a visibility switch for this page on mobile and web. Placement and display are saved on this device.',
				'共有セクションの表示切替はモバイル版とウェブ版に反映されます。配置と表示形式はこの端末に保存されます。'
			)}
		</p>{/if}
	{#if loadingError}<p role="status">
			{loadingError}
			<button class="text-button" onclick={() => retry++}>{uiText('Try again')}</button>
		</p>{/if}
	{#if error}<p role="alert">{error}</p>{/if}
	{#if board === 'library'}
		<details
			class="settings-disclosure"
			data-surface="panel"
			bind:open={editingPages}
			ontoggle={(e) => {
				if (e.currentTarget.open) options = '';
			}}
		>
			<summary>{tr('Library pages', 'ライブラリの各ページ')}</summary>
			{#if editingPages}<div class="fields">
					<label
						>{tr('Library page', 'ライブラリのページ')}<InlineChoice selected={page}>
							<select bind:value={page}>
								{#each categories as category (category)}<option value={category}
										>{uiText(category)}</option
									>{/each}
							</select>
						</InlineChoice></label
					>
					<div class="display-options">
						<CollectionDisplayFields
							settings={pageDisplay}
							onchange={(update) => {
								pageEdits[page] = { ...pageEdits[page], ...update };
							}}
						/>
					</div>
				</div>{/if}
		</details>
	{/if}
	<h2>{uiText(board === 'library' ? 'Library sections' : 'On this screen')}</h2>
	{#if draft.length === 0}<p>{uiText('Add a section below to start your layout.')}</p>{/if}
	<ol
		class:settings-list={draft.length > 0}
		data-surface={draft.length ? 'panel' : undefined}
		bind:this={list}
	>
		{#each draft as item, i (item.id)}
			{@const name = sectionTitle(item)}
			{@const shared = sharedSection(prefs?.pages[board], item.id)}
			<li data-section-id={item.id}>
				<div class="row">
					<strong>{name}</strong>
					<button
						class="tool"
						aria-label={'Move ' + name + ' up'}
						disabled={i === 0}
						onclick={() => move(i, i - 1)}><ArrowUp size={18} /></button
					>
					<button
						class="tool"
						aria-label={'Move ' + name + ' down'}
						disabled={i === draft.length - 1}
						onclick={() => move(i, i + 1)}><ArrowDown size={18} /></button
					>
					<button
						class="tool"
						aria-label={'Customize ' + name}
						aria-expanded={options === item.id}
						onclick={() => {
							editingPages = false;
							options = options === item.id ? '' : item.id;
						}}><SlidersHorizontal size={17} /></button
					>
					<button
						class="tool"
						aria-label={'Remove ' + name}
						onclick={() => {
							draft = draft.filter((s) => s.id !== item.id);
							if (options === item.id) options = '';
						}}><Minus size={18} /></button
					>
				</div>
				{#if shared}<label class="check">
						<input
							type="checkbox"
							disabled={saving || !shared.available}
							checked={toggles[shared.key] ?? shared.enabled}
							onchange={(event) =>
								setVisibility(shared.key, event.currentTarget.checked, shared.enabled)}
						/>
						{tr('Show on mobile and web', 'モバイルとウェブに表示')} · {name}
					</label>{/if}
				{#if options === item.id}<div class="fields">
						{#if item.filter}<p>{filterSummary(item.filter)}</p>
							<button class="secondary" onclick={() => (editing = item.filter!)}
								>{uiText('Edit filters')}</button
							>{/if}
						<label class="check"
							><input type="checkbox" bind:checked={item.preview} />{uiText(
								'Show a preview'
							)}</label
						>
						{#if item.display}
							{@const columnField = item.display.layout === 'grid' ? 'columns' : 'listColumns'}
							<div class="display-options">
								<label
									>{uiText('Display')}<InlineChoice selected={item.display.layout}
										><select bind:value={item.display.layout}
											><option value="list">{uiText('List')}</option><option value="grid"
												>{uiText('Grid')}</option
											></select
										></InlineChoice
									></label
								>
								<label
									>{uiText('Preview rows')}<InlineChoice selected={item.display.rows}
										><select bind:value={item.display.rows}
											>{#each [1, 2, 3, 4, 5, 6] as n (n)}<option value={n}>{n}</option
												>{/each}</select
										></InlineChoice
									></label
								>
								<label
									>{uiText('Columns')}<InlineChoice selected={item.display[columnField]}
										><select bind:value={item.display[columnField]}
											>{#each [1, 2, 3, 4, 5, 6] as n (n)}<option value={n}>{n}</option
												>{/each}</select
										></InlineChoice
									></label
								>
								<label
									>{uiText('Row density')}<InlineChoice selected={item.display.density}
										><select bind:value={item.display.density}
											><option value="compact">{uiText('Compact')}</option><option value="normal"
												>{uiText('Normal')}</option
											><option value="spacious">{uiText('Spacious')}</option></select
										></InlineChoice
									></label
								>
							</div>
						{/if}
					</div>{/if}
			</li>
		{/each}
	</ol>
	<h2>{uiText('Add sections')}</h2>
	{#if board !== 'discover'}<button class="secondary" onclick={() => (editing = {})}
			>{uiText('New filtered section')}</button
		>{/if}
	<input
		type="search"
		aria-label={uiText('Find a section')}
		placeholder={uiText('Find a section')}
		bind:value={filter}
	/>
	{#each ['library', 'discover'] as group (group)}
		{@const matches = choices.filter((w) => w.id.startsWith(group + '-'))}
		{#if matches.length}
			{#if board === 'home'}<h3>
					{group === 'library' ? uiText('Library') : uiText('Discover')}
				</h3>{/if}
			<div class="settings-list" data-surface="panel">
				{#each matches as widget (widget.id)}
					<button
						class="settings-entry"
						aria-label={uiFormat('Add {name}', { name: widget.label })}
						onclick={() => add(widget.id)}><span>{widget.label}</span><Plus size={18} /></button
					>
				{/each}
			</div>
		{/if}
	{/each}
	{#if !choices.length}<p>
			{filter
				? uiText('No matching sections.')
				: uiText('All available sections are on this screen.')}
		</p>{/if}
	<button
		class="text-button reset"
		onclick={() => {
			draft = defaults(board).map(editable);
			options = '';
			filter = '';
		}}>{uiText('Restore default layout')}</button
	>
</div>

{#if editing}
	<FilterSectionDialog
		initial={editing}
		onclose={() => (editing = null)}
		onsave={async (value) => {
			const exists = saved.some((f) => f.id === value.id);
			saved = exists ? saved.map((f) => (f.id === value.id ? value : f)) : [...saved, value];
			draft = draft.map((s) => (s.id === value.id ? { ...s, filter: value } : s));
			editing = null;
			if (!exists) await add(value.id);
		}}
		ondelete={editing.id
			? () => {
					const id = editing?.id;
					saved = saved.filter((s) => s.id !== id);
					draft = draft.filter((s) => s.id !== id);
					editing = null;
					options = '';
				}
			: undefined}
	/>
{/if}

<style>
	.editor {
		max-width: 42rem;
		margin: auto;
	}
	.bar,
	.row,
	.check {
		display: flex;
		align-items: center;
	}
	.bar {
		justify-content: space-between;
	}
	.bar {
		position: sticky;
		top: 0;
		z-index: 1;
		padding-block: 0.3rem;
		background: var(--bg);
		margin-bottom: var(--gap);
	}
	ol {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		padding-inline: 0.65rem 0.2rem;
	}
	.row {
		min-height: 52px;
	}
	.row strong {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		text-align: left;
	}
	.tool {
		min-height: 44px;
		width: 44px;
		flex-shrink: 0;
		display: grid;
		place-items: center;
	}
	.tool:disabled {
		opacity: 0.25;
	}
	.fields {
		display: grid;
		gap: 0.55rem;
		margin: 0.3rem 0 var(--gap);
	}
	.fields label:not(.check) {
		display: grid;
		gap: 0.25rem;
	}
	.display-options {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
		gap: 0.65rem;
	}
	.display-options select {
		min-height: 44px;
		width: 100%;
	}
	.check {
		gap: 0.55rem;
		min-height: 44px;
	}
	.check input {
		accent-color: var(--accent);
	}
	.editor > input[type='search'] {
		display: block;
		width: 100%;
		margin: 0.75rem 0;
	}
	.editor h2 {
		margin-bottom: 0.65rem;
	}
	h3 {
		font-size: 0.92rem;
		margin: 1.1rem 0 0.2rem;
		color: var(--muted);
	}
	.reset {
		margin-top: 1.2rem;
	}
</style>
