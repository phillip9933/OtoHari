import type { Section } from '../boards/layout';
import { isPlayerSlot, playerCanvas, playerColumns } from './composition';

export const GRID_COLUMNS = 30;
export const GRID_ROWS = 40;
const LEGACY_GRID_COLUMNS = 15;
const LEGACY_GRID_ROWS = 20;
export type GridRect = { x: number; y: number; w: number; h: number };
export type GridSection = Section & { grid: GridRect };

export function validGridRect(value: unknown): value is GridRect {
	if (!value || typeof value !== 'object') return false;
	const { x, y, w, h } = value as GridRect;
	return (
		[x, y, w, h].every(Number.isInteger) &&
		x >= 0 &&
		y >= 0 &&
		w > 0 &&
		h > 0 &&
		x + w <= GRID_COLUMNS &&
		y + h <= GRID_ROWS
	);
}

// Version 2 used a 15 × 20 grid. One old cell occupies exactly four current cells.
export const PLAYER_GRID_VERSION = 3;
export function upgradeV2GridRect(value: unknown): GridRect | undefined {
	if (!validGridRect(value)) return;
	const { x, y, w, h } = value;
	const rect = { x: x * 2, y: y * 2, w: w * 2, h: h * 2 };
	return validGridRect(rect) ? rect : undefined;
}

export function gridFits(box: GridRect, sections: readonly Section[], ignoreId?: string): boolean {
	return (
		validGridRect(box) &&
		!sections.some(
			({ id, grid }) =>
				id !== ignoreId &&
				grid &&
				box.x < grid.x + grid.w &&
				grid.x < box.x + box.w &&
				box.y < grid.y + grid.h &&
				grid.y < box.y + box.h
		)
	);
}

export function isPlayerGrid(sections: Section[]): sections is GridSection[] {
	return (
		sections.length > 0 &&
		sections.every((s, i) => validGridRect(s.grid) && gridFits(s.grid, sections.slice(0, i)))
	);
}

export function emptyGridSpace(sections: readonly Section[], w = 1, h = 1): GridRect | undefined {
	if (!validGridRect({ x: 0, y: 0, w, h })) return;
	for (let y = 0; y <= GRID_ROWS - h; y++) {
		for (let x = 0; x <= GRID_COLUMNS - w; x++) {
			const box = { x, y, w, h };
			if (gridFits(box, sections)) return box;
		}
	}
}

export function gridIconSize(id: string): number {
	return id === 'player-toggle' ? 34 : 22;
}

// Inset the controls while letting the cover reach both sides of the player.
export function defaultGridLayout(): GridSection[] {
	const tile = (
		name: string,
		x: number,
		y: number,
		w: number,
		h: number,
		options: Partial<Section> = {}
	): GridSection => ({
		id: 'player-' + name,
		title: '',
		preview: true,
		...options,
		grid: { x, y, w, h }
	});
	return [
		tile('artwork', 0, 0, 30, 22),
		tile('title', 2, 22, 19, 2, { maxLines: 1 }),
		tile('artist', 2, 24, 19, 2, { maxLines: 1 }),
		tile('favorite', 21, 22, 4, 3),
		tile('more', 25, 22, 4, 3),
		tile('timeline', 2, 26, 26, 3),
		tile('rating', 6, 29, 18, 2, { iconSize: 24 }),
		tile('repeat', 0, 31, 6, 5, { iconSize: 18 }),
		tile('previous', 6, 31, 6, 5, { iconSize: 28 }),
		tile('toggle', 12, 31, 6, 5, { icon: 'play', iconSize: 42 }),
		tile('next', 18, 31, 6, 5, { iconSize: 28 }),
		tile('shuffle', 24, 31, 6, 5, { iconSize: 18 }),
		...['lyrics', 'output', 'queue'].map((id, i) => tile(id, 3 + i * 8, 36, 8, 4))
	];
}

// Allocate integer grid spans proportionally, reserving a cell for every visible field.
function spans(total: number, weights: number[], minimum = weights.map(() => 1)): number[] {
	const space = total - minimum.reduce((a, b) => a + b, 0);
	const sum = weights.reduce((a, b) => a + b, 0);
	const exact = weights.map((weight) => (weight / sum) * space);
	const result = exact.map((v, i) => minimum[i] + Math.floor(v));
	const byRemainder = exact
		.map((v, i) => ({ i, fraction: v - Math.floor(v) }))
		.sort((a, b) => b.fraction - a.fraction);
	const remainder = total - result.reduce((a, b) => a + b, 0);
	for (const { i } of byRemainder.slice(0, remainder)) result[i]++;
	return result;
}

function place(section: Section, { x, y, w, h }: GridRect, scale: number): GridSection {
	const placed = { ...section, grid: { x: x * scale, y: y * scale, w: w * scale, h: h * scale } };
	delete placed.sameRow;
	delete placed.stack;
	delete placed.placement;
	return placed;
}

export function toPlayerGrid(sections: Section[]): GridSection[] {
	if (isPlayerGrid(sections)) return sections.map((s) => ({ ...s, grid: { ...s.grid } }));
	const rows = playerCanvas(sections).map(playerColumns);
	// Preserve the old integer rounding before subdividing each coarse cell.
	const fields = rows.flat(2);
	const scale = fields.length <= LEGACY_GRID_COLUMNS * LEGACY_GRID_ROWS ? 2 : 1;
	const columnsAcross = GRID_COLUMNS / scale;
	const rowsDown = GRID_ROWS / scale;
	const minimum = rows.map((cols) => Math.max(...cols.map((cells) => cells.length)));
	if (minimum.reduce((sum, n) => sum + n, 0) > rowsDown) {
		// Even very tall old layouts can retain their fields, in the original reading order.
		if (fields.length > GRID_COLUMNS * GRID_ROWS)
			throw Error('This layout has more items than the player grid can hold.');
		const columns = Math.ceil(fields.length / rowsDown);
		const widths = spans(columnsAcross, Array(columns).fill(1));
		return fields.map((s, i) => {
			const c = i % columns;
			return place(
				s,
				{
					x: widths.slice(0, c).reduce((sum, w) => sum + w, 0),
					y: Math.floor(i / columns),
					w: widths[c],
					h: 1
				},
				scale
			);
		});
	}
	const heights = spans(
		rowsDown,
		rows.map((cols) => {
			const fields = cols.flat();
			const natural = fields.some((s) => s.id === 'player-artwork') ? 360 : 44;
			return Math.max(natural, ...fields.map((s) => s.minHeight ?? 0));
		}),
		minimum
	);
	const grid: GridSection[] = [];
	let y = 0;
	rows.forEach((cols, r) => {
		const widths = spans(
			columnsAcross,
			cols.map((cells) => cells[0].width ?? 1)
		);
		let x = 0;
		cols.forEach((cells, c) => {
			const subHeights = spans(
				heights[r],
				cells.map((s) => (s.id === 'player-artwork' ? 8 : 1))
			);
			let subY = y;
			cells.forEach((s, i) => {
				grid.push(place(s, { x, y: subY, w: widths[c], h: subHeights[i] }, scale));
				subY += subHeights[i];
			});
			x += widths[c];
		});
		y += heights[r];
	});
	return grid;
}

export function editablePlayerGrid(sections: Section[]) {
	return toPlayerGrid(sections).filter((section) => !isPlayerSlot(section.id));
}

export function emptyPlayerTile(): GridSection {
	return { id: 'player-slot-1', title: '', preview: true, grid: { x: 0, y: 0, w: 1, h: 1 } };
}
