<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import {
		ArrowLeft,
		Check,
		Eye,
		Maximize2,
		Pencil,
		Plus,
		Redo2,
		Undo2,
		ZoomIn,
		ZoomOut
	} from '@lucide/svelte';
	import { tr, uiText } from '../i18n';
	import { available, sectionTitle, type Section } from '../boards/layout';
	import PlayerView from '../PlayerView.svelte';
	import PlayerCellAppearance from './PlayerCellAppearance.svelte';
	import PlayerStyleTransfer from './PlayerStyleTransfer.svelte';
	import { sampleSession } from './samplePlayer';
	import {
		defaultPlayerText,
		isPlayerSlot,
		isPlayerText,
		nextTextId,
		playerTokens,
		splitAvailable,
		splitPlayerSection
	} from './composition';
	import { playerWidgets } from './layout';
	import {
		GRID_COLUMNS,
		GRID_ROWS,
		defaultGridLayout,
		emptyGridSpace,
		gridFits,
		editablePlayerGrid,
		emptyPlayerTile,
		type GridRect,
		type GridSection
	} from './grid';
	import { gridGesture, gridZoom, MAX_GRID_ZOOM } from './gridGesture';
	import type { PlayerDraft } from './playerDraft';

	let {
		recovery,
		onback,
		onsave
	}: { recovery: PlayerDraft; onback: () => void; onsave: (sections: Section[]) => void } =
		$props();
	let items = $state.raw(untrack(() => editablePlayerGrid(recovery.initial)));
	const empty = emptyPlayerTile();
	let draft = $derived(items.length ? items : [empty]);
	let selected = $state(
		untrack(() => items.find((s) => s.id === 'player-toggle')?.id ?? items[0]?.id ?? '')
	);
	let field = $derived(items.find((s) => s.id === selected));
	let panel = $state<'edit' | 'pick' | null>(null);
	let preview = $state(false),
		leaving = $state(false),
		message = $state(''),
		recoveryIssue = $state(''),
		saveIssue = $state('');
	let past = $state.raw<GridSection[][]>([]),
		future = $state.raw<GridSection[][]>([]);
	let group: Element | null = null;
	let stage: HTMLDivElement;
	let zoom = $state(1);
	let zoomControls: ReturnType<typeof gridZoom>;
	let anchor: HTMLElement | null = null;
	let previewButton: HTMLButtonElement;
	let templateInput = $state<HTMLTextAreaElement>(null!);
	let query = $state(''),
		splitFrom = $state('');
	let space = $derived(
		emptyGridSpace(items, 6, 4) ?? emptyGridSpace(items, 4, 2) ?? emptyGridSpace(items)
	);
	let destination = $state.raw<GridRect>();
	let drag = $state.raw<{
		id: string;
		origin: GridRect;
		next: GridRect;
		resize: boolean;
		unitX: number;
		unitY: number;
	}>();
	const choices = available('player').filter(
		(s) => !['player-track', 'player-menu', 'player-tools'].includes(s.id)
	);
	let matches = $derived(
		choices.filter(
			(s) =>
				(isPlayerText(s.id) || !items.some((i) => i.id === s.id)) &&
				uiText(s.label).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
		)
	);

	$effect(() => {
		if (leaving) return;
		let current = true;
		void recovery.remember(draft).then((issue) => {
			if (current) recoveryIssue = issue;
		});
		return () => {
			current = false;
		};
	});
	// Lay out at the live player's dimensions first. Scaling the finished canvas keeps
	// text, icons and touch geometry in the same proportion in both draft views.
	function fitDraft(node: HTMLElement) {
		const shell = node.closest<HTMLElement>('[data-part="app"]')!;
		const main = shell.querySelector('main')!;
		function measure() {
			const style = getComputedStyle(shell);
			const width =
				shell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
			const height =
				shell.clientHeight -
				parseFloat(style.paddingTop) -
				(parseFloat(style.getPropertyValue('--notice-height')) || 0);
			if (!width || !height || !node.clientHeight) return;
			const scale = Math.min(1, node.clientWidth / width, node.clientHeight / height);
			node.style.setProperty('--draft-width', width + 'px');
			node.style.setProperty('--draft-height', height + 'px');
			node.style.setProperty('--draft-scale', String(scale));
		}
		const observer = new ResizeObserver(measure);
		observer.observe(shell);
		observer.observe(main);
		observer.observe(node);
		measure();
		return { destroy: () => observer.disconnect() };
	}
	function commit(next: GridSection[]) {
		const input = document.activeElement;
		const typing = input?.matches('textarea, input[type=text]') ? input : null;
		if (!typing || typing !== group || !past.length) past = [...past.slice(-29), items];
		group = typing;
		future = [];
		items = next;
		message = '';
	}
	function travel(redo: boolean) {
		const from = redo ? future : past;
		if (!from.length) return;
		const target = from[from.length - 1];
		if (redo) {
			future = from.slice(0, -1);
			past = [...past, items];
		} else {
			past = from.slice(0, -1);
			future = [...future, items];
		}
		items = target;
		group = null;
		panel = null;
		if (!items.some((s) => s.id === selected)) selected = items[0]?.id ?? '';
		message = redo ? uiText('Layout edit restored.') : uiText('Layout edit undone.');
	}
	function modify(patch: Partial<Section>) {
		if (!field) return;
		commit(items.map((s) => (s.id === selected ? { ...s, ...patch } : s)));
	}
	function inspect(from: HTMLElement) {
		anchor = from;
		group = null;
		message = '';
		panel = 'edit';
	}
	function closePanel() {
		panel = null;
		group = null;
		splitFrom = '';
		message = '';
		const target = anchor;
		void tick().then(() => target?.isConnected && target.focus({ preventScroll: true }));
	}
	function pick(from: HTMLElement, split = false) {
		const rect =
			split && field
				? {
						...field.grid,
						y: field.grid.y + Math.ceil(field.grid.h / 2),
						h: Math.floor(field.grid.h / 2)
					}
				: space;
		if (!rect?.h) return;
		if (!split) anchor = from;
		splitFrom = split ? selected : '';
		destination = rect;
		query = '';
		message = '';
		panel = 'pick';
	}
	// Prefer a useful initial size whenever there is room. A split always keeps
	// the exact lower half of the tile the listener chose.
	function suggestedBox(id: string, fallback: GridRect): GridRect {
		let width = 6,
			height = 4;
		if (id === 'player-artwork') {
			width = GRID_COLUMNS;
			height = 18;
		} else if (
			[
				'player-timeline',
				'player-seek',
				'player-transport',
				'player-modes',
				'player-up-next'
			].includes(id)
		) {
			width = GRID_COLUMNS;
			height = 6;
		} else if (
			[
				'player-rating',
				'player-title',
				'player-artist',
				'player-album',
				'player-heading',
				'player-text'
			].includes(id)
		) {
			width = 18;
		} else if (id === 'player-quality') width = 12;
		for (let h = height; h >= 1; h--) {
			for (let w = width; w >= fallback.w; w--) {
				const anchored = { ...fallback, w, h };
				if (gridFits(anchored, items)) return anchored;
				const free = emptyGridSpace(items, w, h);
				if (free) return free;
			}
		}
		return fallback;
	}
	function choose(id: string) {
		if (!destination) return;
		const rect = splitFrom ? destination : suggestedBox(id, destination);
		const sections = items.map((s) =>
			s.id === splitFrom ? { ...s, grid: { ...s.grid, h: rect.y - s.grid.y } } : s
		);
		if (!gridFits(rect, sections)) return;
		const key = isPlayerText(id) ? nextTextId(items) : id;
		commit([
			...sections,
			{
				id: key,
				title: '',
				preview: playerWidgets.find((w) => w.id === id)?.enabled ?? true,
				grid: rect
			}
		]);
		selected = key;
		closePanel();
		void focusSelected();
	}
	async function focusSelected() {
		await tick();
		stage
			?.querySelector<HTMLElement>(
				'[data-grid-handle="move"][data-field-id="' + CSS.escape(selected) + '"]'
			)
			?.focus({ preventScroll: true });
	}
	function remove() {
		commit(items.filter((s) => s.id !== selected));
		selected = items[0]?.id ?? '';
		closePanel();
		void focusSelected();
	}
	function splitGroup() {
		if (!field) return;
		const parts = splitPlayerSection(field).filter((part) => !items.some((s) => s.id === part.id));
		if (!parts.length) {
			message = tr(
				'These controls are already on the grid.',
				'これらの操作はすでに配置されています。'
			);
			return;
		}
		const { x, y, w, h } = field.grid;
		const horizontal = w >= parts.length;
		if (!horizontal && h < parts.length) {
			message = tr(
				'Enlarge the tile to fit the individual controls.',
				'各操作が入るようにタイルを大きくしてください。'
			);
			return;
		}
		const length = horizontal ? w : h;
		const placed = parts.map((part, i) => {
			const start = Math.floor((i * length) / parts.length),
				span = Math.floor(((i + 1) * length) / parts.length) - start;
			return {
				...part,
				grid: horizontal ? { x: x + start, y, w: span, h } : { x, y: y + start, w, h: span }
			};
		});
		commit(items.flatMap((s) => (s.id === selected ? placed : [s])));
		selected = placed[0].id;
		closePanel();
		void focusSelected();
	}
	async function token(key: string) {
		if (!field) return;
		const el = templateInput,
			text = field.template ?? defaultPlayerText,
			insert = '{' + key + '}';
		const start = el.selectionStart,
			end = el.selectionEnd;
		if (text.length - (end - start) + insert.length > 512) return;
		modify({ template: text.slice(0, start) + insert + text.slice(end) });
		await tick();
		el.focus();
		el.setSelectionRange(start + insert.length, start + insert.length);
	}
	function same(a: GridRect, b: GridRect) {
		return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
	}
	function placed(id: string, rect: GridRect, swap: boolean): GridSection[] | undefined {
		const source = items.find((s) => s.id === id);
		if (!source) return;
		if (gridFits(rect, items, id))
			return items.map((s) => (s === source ? { ...s, grid: rect } : s));
		if (!swap || source.grid.w !== rect.w || source.grid.h !== rect.h) return;
		const other = items.find((s) => s !== source && same(s.grid, rect));
		if (other)
			return items.map((s) =>
				s === source ? { ...s, grid: rect } : s === other ? { ...s, grid: source.grid } : s
			);
	}
	const occupied = () =>
		tr('That space is occupied or outside the grid.', 'そこには配置できません。');
	function position(key: keyof GridRect, el: HTMLInputElement) {
		if (!field) return;
		const offset = key === 'x' || key === 'y' ? 1 : 0;
		const value = el.valueAsNumber - offset;
		const rect = { ...field.grid, [key]: value };
		const result = placed(selected, rect, offset === 1);
		if (result) {
			if (!same(field.grid, rect)) commit(result);
		} else {
			el.value = String(field.grid[key] + offset);
			message = occupied();
		}
	}
	function begin(id: string, resize: boolean) {
		const s = items.find((it) => it.id === id);
		const bounds = stage.querySelector('[data-player-grid]')?.getBoundingClientRect();
		if (!s || !bounds?.width || !bounds.height) return;
		selected = id;
		message = '';
		panel = null;
		drag = {
			id,
			resize,
			origin: s.grid,
			next: s.grid,
			unitX: bounds.width / GRID_COLUMNS,
			unitY: bounds.height / GRID_ROWS
		};
	}
	function move(dx: number, dy: number) {
		if (!drag) return;
		const { origin, resize } = drag,
			a = Math.round(dx / drag.unitX),
			b = Math.round(dy / drag.unitY);
		const next = resize
			? {
					...origin,
					w: clamp(origin.w + a, 1, GRID_COLUMNS - origin.x),
					h: clamp(origin.h + b, 1, GRID_ROWS - origin.y)
				}
			: {
					...origin,
					x: clamp(origin.x + a, 0, GRID_COLUMNS - origin.w),
					y: clamp(origin.y + b, 0, GRID_ROWS - origin.h)
				};
		if (!same(next, drag.next)) drag = { ...drag, next };
	}
	function clamp(n: number, min: number, max: number) {
		return Math.max(min, Math.min(max, n));
	}
	function end(apply: boolean) {
		if (!drag) return;
		const { id, origin, next, resize } = drag;
		drag = undefined;
		if (!apply || same(origin, next)) return;
		const result = placed(id, next, !resize);
		if (result) commit(result);
		else message = occupied();
	}
	function arrow(e: KeyboardEvent, s: Section) {
		if (!s.grid || !['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
		e.preventDefault();
		selected = s.id;
		const dx = Number(e.key === 'ArrowRight') - Number(e.key === 'ArrowLeft'),
			dy = Number(e.key === 'ArrowDown') - Number(e.key === 'ArrowUp');
		const rect = e.shiftKey
			? { ...s.grid, w: s.grid.w + dx, h: s.grid.h + dy }
			: { ...s.grid, x: s.grid.x + dx, y: s.grid.y + dy };
		const result = placed(s.id, rect, !e.shiftKey);
		if (result) commit(result);
		else message = occupied();
	}
	function location(box: GridRect) {
		return (
			'left:' +
			(box.x / GRID_COLUMNS) * 100 +
			'%;top:' +
			(box.y / GRID_ROWS) * 100 +
			'%;width:' +
			(box.w / GRID_COLUMNS) * 100 +
			'%;height:' +
			(box.h / GRID_ROWS) * 100 +
			'%'
		);
	}
	function save() {
		if (leaving) return;
		leaving = true;
		try {
			onsave(draft);
		} catch {
			leaving = false;
			saveIssue = uiText('Could not save this layout on the device. Your edits are still here.');
			return;
		}
		void recovery.clear().catch(() => {});
		onback();
	}
	async function cancel() {
		if (leaving) return;
		leaving = true;
		try {
			await recovery.clear();
			onback();
		} catch {
			leaving = false;
			saveIssue = uiText('Could not discard the recovery copy. Try Cancel again.');
		}
	}
	function closePreview() {
		preview = false;
		void tick().then(() => previewButton?.focus({ preventScroll: true }));
	}
	function modal(node: HTMLDialogElement) {
		node.showModal();
		return {
			destroy() {
				node.close();
			}
		};
	}
	function panelPosition(node: HTMLDialogElement) {
		function update() {
			const box = stage.getBoundingClientRect();
			node.style.setProperty('--panel-left', Math.max(6, box.left + 6) + 'px');
			node.style.setProperty(
				'--panel-width',
				Math.max(180, Math.min(box.width - 12, innerWidth - 12)) + 'px'
			);
			node.style.setProperty(
				'--panel-top',
				Math.min(innerHeight - 140, Math.max(6, box.top + 6)) + 'px'
			);
			node.style.setProperty('--panel-bottom', Math.max(6, innerHeight - box.bottom + 6) + 'px');
		}
		update();
		node.showModal();
		const observer = new ResizeObserver(update);
		observer.observe(stage);
		window.addEventListener('resize', update);
		window.addEventListener('scroll', update, true);
		return {
			destroy() {
				observer.disconnect();
				window.removeEventListener('resize', update);
				window.removeEventListener('scroll', update, true);
				node.close();
			}
		};
	}
	let pullY = 0;
	function outside(e: MouseEvent) {
		const el = e.currentTarget as HTMLDialogElement;
		const box = el.getBoundingClientRect();
		if (
			e.target === el &&
			(e.clientX < box.left ||
				e.clientX > box.right ||
				e.clientY < box.top ||
				e.clientY > box.bottom)
		)
			closePanel();
	}
	onMount(() => {
		zoomControls = gridZoom(stage, (scale) => {
			zoom = scale;
		});
		function back(e: Event) {
			if (e.defaultPrevented) return;
			if (preview) closePreview();
			else if (panel) closePanel();
			else if (document.querySelector('dialog[open]')) return;
			else void cancel();
			e.preventDefault();
		}
		function shortcut(e: KeyboardEvent) {
			if (
				e.defaultPrevented ||
				preview ||
				panel ||
				!(e.ctrlKey || e.metaKey) ||
				e.altKey ||
				(e.target instanceof Element &&
					e.target.closest('input,textarea,select,[contenteditable=true]'))
			)
				return;
			const key = e.key.toLowerCase();
			if (key === 'z' || key === 'y') {
				e.preventDefault();
				travel(key === 'y' || e.shiftKey);
			}
		}
		window.addEventListener('dn-back', back);
		window.addEventListener('keydown', shortcut);
		return () => {
			zoomControls.destroy();
			window.removeEventListener('dn-back', back);
			window.removeEventListener('keydown', shortcut);
		};
	});
</script>

<div
	class="editor"
	data-part="layout-editor"
	onfocusout={() => {
		group = null;
	}}
>
	<header class="bar">
		<h2>{tr('Player layout', 'プレーヤーレイアウト')}</h2>
		<button
			class="history"
			aria-label={uiText('Undo layout edit')}
			disabled={!past.length}
			onclick={() => travel(false)}><Undo2 size={18} /></button
		>
		{#if future.length}<button
				class="history"
				aria-label={uiText('Redo layout edit')}
				onclick={() => travel(true)}><Redo2 size={18} /></button
			>{/if}
		<button
			class="preview-button"
			aria-label={uiText('Preview current draft')}
			onclick={() => {
				preview = true;
			}}
			bind:this={previewButton}><Eye size={16} />{uiText('Preview')}</button
		>
	</header>
	{#if recovery.recovered}<p class="note" role="status">
			{uiText('Recovered your unsaved layout.')}
		</p>{/if}
	{#if saveIssue}<p class="note" role="alert">{saveIssue}</p>{/if}
	{#if recoveryIssue}<p class="note" role="alert">{recoveryIssue}</p>{/if}
	{#snippet overlay(s: Section)}
		{#if !isPlayerSlot(s.id)}
			<button
				class="hit"
				class:selected={selected === s.id}
				data-grid-handle="move"
				data-field-id={s.id}
				aria-label={uiText('Select') + ' ' + sectionTitle(s)}
				aria-pressed={selected === s.id}
				onclick={() => {
					selected = s.id;
					message = '';
				}}
				onkeydown={(e) => arrow(e, s)}
			>
				{#if selected === s.id}
					<span class="corner" data-grid-handle="resize" data-field-id={s.id} aria-hidden="true">
						<Maximize2 size={12} />
					</span>
				{/if}
			</button>
		{/if}
	{/snippet}
	{#snippet gridOverlay()}
		{#if drag}
			{@const activeDrag = drag}
			{@const allowed = !!placed(activeDrag.id, activeDrag.next, !activeDrag.resize)}
			{@const swap =
				!activeDrag.resize &&
				items.some((s) => s.id !== activeDrag.id && same(s.grid, activeDrag.next))}
			<div class="ghost" class:blocked={!allowed} style={location(drag.next)} aria-hidden="true">
				{#if !allowed}<span>{tr('Occupied', '使用中')}</span>{:else if swap}<span
						>{tr('Swap', '入れ替え')}</span
					>{:else if drag.resize}<span>{drag.next.w} × {drag.next.h}</span>{/if}
			</div>
		{/if}
	{/snippet}
	<div class="stage" bind:this={stage} use:fitDraft use:gridGesture={{ begin, move, end }}>
		<div class="zoom-surface">
			<PlayerView
				session={sampleSession}
				expanded={true}
				onexpand={() => {}}
				oncollapse={() => {}}
				onerror={() => {}}
				editor={{ sections: draft, selected, overlay, gridOverlay }}
			/>
		</div>
	</div>
	<div class="tools">
		<button disabled={!space} onclick={(e) => pick(e.currentTarget)}
			><Plus size={17} />{uiText('Add item')}</button
		>
		<button disabled={!field} onclick={(e) => inspect(e.currentTarget)}
			><Pencil size={15} />{uiText('Edit item')}</button
		>
		<div class="zoom-tools" role="group" aria-label={tr('Grid zoom', 'グリッドのズーム')}>
			<button
				aria-label={tr('Zoom out', '縮小')}
				disabled={zoom <= 1}
				onclick={() => zoomControls.set(zoom - 0.5)}><ZoomOut size={17} /></button
			>
			<button
				class="zoom-level"
				aria-label={tr('Fit grid to screen', 'グリッドを画面に合わせる')}
				onclick={() => zoomControls.set(1)}>{Math.round(zoom * 100)}%</button
			>
			<button
				aria-label={tr('Zoom in', '拡大')}
				disabled={zoom >= MAX_GRID_ZOOM}
				onclick={() => zoomControls.set(zoom + 0.5)}><ZoomIn size={17} /></button
			>
		</div>
	</div>
	<p class="hint" role="status">
		{message ||
			(space
				? tr(
						'Pinch to zoom · Hold to move · Drag the corner to resize',
						'ピンチで拡大縮小 · 長押しで移動 · 角をドラッグしてサイズ変更'
					)
				: tr(
						'Grid full · Resize or split a tile to make room',
						'グリッドがいっぱいです。サイズ変更または分割で空きを作れます。'
					))}
	</p>
	<div class="saves">
		<button class="text-button" onclick={cancel}>{uiText('Cancel')}</button><button
			class="primary"
			onclick={save}
			aria-label={uiText('Save layout')}><Check size={16} />{uiText('Save layout')}</button
		>
	</div>
	<div class="extras">
		<button
			class="text-button"
			onclick={() => {
				commit(defaultGridLayout());
				selected = 'player-toggle';
			}}>{uiText('Restore default layout')}</button
		>
		<PlayerStyleTransfer
			sections={draft}
			onload={(s) => {
				commit(editablePlayerGrid(s));
				selected = items[0]?.id ?? '';
			}}
		/>
	</div>
</div>

{#if panel}
	<dialog
		class="inspector"
		class:upper={panel === 'edit' && !!field && field.grid.y + field.grid.h / 2 >= GRID_ROWS / 2}
		use:panelPosition
		aria-labelledby="grid-panel-title"
		oncancel={(e) => {
			e.preventDefault();
			closePanel();
		}}
		onclick={outside}
	>
		<div class="sheet-head">
			<button
				class="grip"
				aria-label={tr('Close panel', '閉じる')}
				onclick={closePanel}
				onpointerdown={(e) => {
					pullY = e.clientY;
					e.currentTarget.setPointerCapture(e.pointerId);
				}}
				onpointerup={(e) => {
					if (e.clientY - pullY > 36) closePanel();
				}}><span></span></button
			>
			<div>
				<h3 id="grid-panel-title">
					{panel === 'pick' ? uiText('Add item') : field ? sectionTitle(field) : ''}
				</h3>
				<button class="text-button" onclick={closePanel}>{uiText('Done')}</button>
			</div>
		</div>
		<div class="panel-body">
			{#if panel === 'pick'}
				<input
					type="search"
					aria-label={uiText('Find a feature')}
					placeholder={uiText('Find a feature')}
					bind:value={query}
				/>
				<div class="choices">
					{#each matches as option (option.id)}
						<button onclick={() => choose(option.id)}
							>{uiText(option.label)}<Plus size={16} /></button
						>
					{:else}<p>{uiText('No matching features.')}</p>{/each}
				</div>
			{:else if field}
				<PlayerCellAppearance {field} change={modify} />
				{#if isPlayerText(field.id)}
					<label
						>{uiText('Text template')}<textarea
							bind:this={templateInput}
							maxlength={512}
							value={field.template ?? defaultPlayerText}
							oninput={(e) => modify({ template: e.currentTarget.value })}
						></textarea></label
					>
					<div class="tokens">
						{#each playerTokens as t (t)}<button onclick={() => token(t)}>{'{' + t + '}'}</button
							>{/each}
					</div>
				{/if}
				{#if playerWidgets.find((w) => w.id === field.id)?.option}
					<label class="check"
						><input
							type="checkbox"
							checked={field.preview}
							onchange={(e) => modify({ preview: e.currentTarget.checked })}
						/>{uiText(playerWidgets.find((w) => w.id === field?.id)?.option ?? '')}</label
					>
				{/if}
				<label
					>{uiText('Section title')}<input
						type="text"
						maxlength={64}
						value={field.title}
						placeholder={sectionTitle({ ...field, title: '' })}
						oninput={(e) => modify({ title: e.currentTarget.value })}
					/></label
				>
				<details>
					<summary>{tr('Position and size', '位置とサイズ')}</summary>
					<div class="coordinates">
						{#each [['x', tr('Column', '列'), GRID_COLUMNS], ['y', tr('Row', '行'), GRID_ROWS], ['w', tr('Width in cells', '幅（マス）'), GRID_COLUMNS], ['h', tr('Height in cells', '高さ（マス）'), GRID_ROWS]] as [key, label, max] (key)}
							{@const prop = key as keyof GridRect}
							<label
								>{label}<input
									type="number"
									min="1"
									{max}
									value={field.grid[prop] + Number(prop === 'x' || prop === 'y')}
									onchange={(e) => position(prop, e.currentTarget)}
								/></label
							>
						{/each}
					</div>
				</details>
				<button
					class="panel-action"
					disabled={field.grid.h < 2}
					onclick={(e) => pick(e.currentTarget, true)}
					><Plus size={16} />{tr('Place another item underneath', '下に別の項目を配置')}</button
				>
				{#if splitAvailable(field.id)}<button class="panel-action" onclick={splitGroup}
						>{tr('Split into individual controls', '個別の操作に分割')}</button
					>{/if}
				<button class="panel-action remove" onclick={remove}>{uiText('Remove item')}</button>
				{#if message}<p role="status">{message}</p>{/if}
			{/if}
		</div>
	</dialog>
{/if}
{#if preview}
	<dialog
		class="full-preview"
		data-part="layout-preview"
		aria-label={uiText('Player layout preview')}
		use:modal
		oncancel={(e) => {
			e.preventDefault();
			closePreview();
		}}
	>
		<button class="text-button" onclick={closePreview}
			><ArrowLeft size={17} />{uiText('Back to editing')}</button
		>
		<div class="preview-stage" use:fitDraft>
			<PlayerView
				session={sampleSession}
				expanded={true}
				onexpand={() => {}}
				oncollapse={() => {}}
				onerror={() => {}}
				editor={{ sections: draft }}
			/>
		</div>
	</dialog>
{/if}

<style>
	:global(main):has(.editor) {
		container-type: size;
	}
	:global(.shell:not(:has(> footer)) > main):has(.editor) {
		margin-block-end: max(env(safe-area-inset-bottom), var(--safe-area-inset-bottom, 0px));
	}
	:global(html[data-navigation='floating'] .shell:has(> footer) > main):has(.editor) {
		margin-block-end: var(--footer-height);
	}
	.editor {
		width: min(100%, 40rem);
		margin-inline: auto;
		color: var(--text);
		background: var(--bg);
		display: flex;
		flex-direction: column;
		max-height: calc(100cqh - 2 * var(--gap));
		gap: 0.42rem;
		min-width: 0;
	}
	.editor > :not(.stage) {
		flex: none;
	}
	:global(.shell:has([data-part='layout-editor']) > .mast) {
		display: none;
	}
	.bar,
	.tools,
	.saves,
	.sheet-head > div,
	.panel-action,
	.choices button,
	.preview-button {
		display: flex;
		align-items: center;
	}
	.bar {
		gap: 0.3rem;
		padding: 0.15rem 0.2rem;
	}
	header.bar h2 {
		margin: 0 auto 0 0;
		font-size: 1.15rem;
		color: var(--heading, var(--text));
	}
	.history {
		border: 0;
		background: transparent;
		min-width: 2.55rem;
		min-height: 2.55rem;
		padding: 0.3rem;
		box-shadow: none;
	}
	.history:disabled {
		opacity: 0.34;
	}
	.preview-button {
		gap: 0.35rem;
		padding: 0.35rem 0.7rem;
		min-height: 2.45rem;
	}
	.stage {
		position: relative;
		isolation: isolate;
		width: 100%;
		flex: 0 1 54rem;
		min-height: 16rem;
		overflow: auto;
		overflow-anchor: none;
		scrollbar-width: none;
		touch-action: pan-x pan-y;
		--canvas-scale: calc(var(--draft-scale, 1) * var(--grid-zoom, 1));
	}
	.stage::-webkit-scrollbar {
		display: none;
	}
	.zoom-surface {
		position: relative;
		overflow: clip;
		width: max(100%, calc(var(--draft-width, 100%) * var(--canvas-scale)));
		height: max(100%, calc(var(--draft-height, 100%) * var(--canvas-scale)));
	}
	.stage :global([data-part='sample-player']),
	.preview-stage :global([data-part='draft-player']) {
		position: absolute;
		inset: 50% auto auto 50%;
		margin: 0;
		width: var(--draft-width, 100%);
		height: var(--draft-height, 100%);
		min-height: 0;
		max-height: none;
		transform: translate(-50%, -50%) scale(var(--canvas-scale, var(--draft-scale, 1)));
	}
	.stage :global([data-player-grid]) {
		outline: 1px solid var(--line);
		outline-offset: -1px;
		background-image:
			linear-gradient(
				to right,
				color-mix(in srgb, var(--text) 12%, transparent) 1px,
				transparent 1px
			),
			linear-gradient(
				to bottom,
				color-mix(in srgb, var(--text) 12%, transparent) 1px,
				transparent 1px
			);
		background-size: calc(100% / var(--grid-cols)) calc(100% / var(--grid-rows));
	}
	.stage :global([data-section-id]) {
		outline: 0;
		min-width: 0;
		min-height: 0;
	}
	.hit {
		position: absolute;
		inset: 0;
		z-index: 2;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		padding: 0;
		outline: 0;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 19%, transparent);
		background: transparent;
		border: 0;
		border-radius: 4px;
		user-select: none;
		touch-action: pan-x pan-y;
	}
	.hit.selected,
	.hit:focus-visible {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.hit:focus-visible {
		outline: 1px solid var(--text);
		outline-offset: -4px;
	}
	.corner {
		display: grid;
		place-items: center;
		position: absolute;
		z-index: 3;
		inset: auto 0 0 auto;
		width: min(45%, calc(23px / var(--canvas-scale, 1)));
		height: min(45%, calc(23px / var(--canvas-scale, 1)));
		min-width: 0;
		min-height: 0;
		padding: 0;
		border: 0;
		background: var(--accent);
		color: var(--bg);
		border-radius: 4px 0 3px 0;
		touch-action: none;
		cursor: nwse-resize;
	}
	.ghost {
		position: absolute;
		display: grid;
		place-items: center;
		pointer-events: none;
		z-index: 5;
		border: 2px dashed var(--accent);
		border-radius: 4px;
		background: color-mix(in srgb, var(--accent) 22%, transparent);
	}
	.ghost span {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border-radius: 4px;
		background: var(--bg);
		color: var(--text);
		padding: 0.08rem 0.2rem;
		font-size: 0.72rem;
	}
	.ghost.blocked {
		border-color: var(--danger, #ff8378);
		background: color-mix(in srgb, var(--danger, #ff8378) 23%, transparent);
	}
	.tools,
	.saves {
		justify-content: space-between;
		gap: 0.4rem;
	}
	.tools {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
	}
	.tools button,
	.saves button {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		min-height: 2.6rem;
	}
	.tools > button:first-child {
		background: color-mix(in srgb, var(--accent) 14%, var(--surface));
		color: var(--accent);
	}
	.zoom-tools {
		display: flex;
		align-items: center;
	}
	.zoom-tools button {
		min-width: 2rem;
		padding: 0.2rem;
		border: 0;
		background: transparent;
		box-shadow: none;
	}
	.zoom-level {
		font-size: 0.76rem;
		font-variant-numeric: tabular-nums;
	}
	.hint,
	.note {
		text-align: center;
		color: var(--muted);
		font-size: 0.8rem;
		margin: 0;
	}
	.extras {
		margin-top: 0.55rem;
		border-top: 1px solid var(--line);
		padding-top: 0.55rem;
	}
	.inspector,
	.full-preview {
		box-sizing: border-box;
		color: var(--text);
		background: var(--bg);
		border: 1px solid var(--line);
	}
	.inspector {
		position: fixed;
		inset: auto auto var(--panel-bottom) var(--panel-left);
		width: var(--panel-width);
		max-width: none;
		max-height: min(58dvh, 30rem);
		margin: 0;
		padding: 0;
		overflow: hidden;
		border-radius: 1rem;
		box-shadow: 0 10px 36px #0005;
	}
	.inspector[open] {
		display: flex;
		flex-direction: column;
	}
	.panel-body {
		min-height: 0;
		padding: 0 0.8rem 0.8rem;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.inspector.upper {
		top: var(--panel-top);
		bottom: auto;
	}
	.inspector::backdrop {
		background: #0002;
	}
	.sheet-head {
		flex: none;
		padding: 0 0.8rem 0.3rem;
	}
	.sheet-head > div {
		justify-content: space-between;
	}
	.sheet-head h3 {
		font-size: 1.02rem;
		margin: 0;
	}
	.grip {
		display: grid;
		place-items: center;
		margin-inline: auto;
		width: 4rem;
		height: 1.15rem;
		min-height: 0;
		padding: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
		touch-action: none;
	}
	.grip span {
		width: 1.9rem;
		height: 0.2rem;
		border-radius: 1rem;
		background: var(--muted);
	}
	.choices,
	.panel-body > label,
	.inspector details,
	.inspector .coordinates {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.45rem;
	}
	.choices button,
	.panel-action {
		width: 100%;
		justify-content: space-between;
		min-height: 2.5rem;
		padding: 0.5rem 0.65rem;
		text-align: start;
	}
	.choices button {
		border: 0;
		border-bottom: 1px solid var(--line);
		border-radius: 0;
		background: transparent;
		box-shadow: none;
	}
	.tokens {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.tokens button {
		min-height: 2rem;
		font-size: 0.78rem;
		padding: 0.2rem 0.4rem;
	}
	.inspector label,
	.coordinates label {
		min-width: 0;
	}
	.inspector input:not([type='checkbox']),
	.inspector textarea {
		min-width: 0;
		width: 100%;
	}
	.inspector .check {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.inspector details {
		border-block: 1px solid var(--line);
		padding: 0.5rem 0;
	}
	.inspector .coordinates {
		grid-template-columns: 1fr 1fr;
	}
	.panel-action {
		justify-content: center;
		gap: 0.35rem;
		margin-top: 0.45rem;
	}
	.remove {
		color: var(--danger, #ff8378);
	}
	.full-preview {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100dvh;
		max-height: none;
		max-width: none;
		margin: 0;
		border: 0;
		padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
	}
	.full-preview[open] {
		display: flex;
		flex-direction: column;
	}
	.full-preview > button {
		flex: none;
		align-self: flex-start;
	}
	.preview-stage {
		position: relative;
		overflow: hidden;
		flex: 1;
		min-height: 0;
	}
	@media (max-height: 510px) {
		.inspector {
			max-height: 75dvh;
		}
	}
</style>
