import { expect, test } from '@playwright/test';
import type { Section } from '../src/lib/boards/layout';
import {
	defaultGridLayout,
	emptyGridSpace,
	gridFits,
	isPlayerGrid,
	toPlayerGrid,
	validGridRect
} from '../src/lib/player/grid';
import { playerOptions } from '../src/lib/player/layout';

test('the starter grid arranges artwork, rating, transport and utility actions', () => {
	const layout = defaultGridLayout();
	expect(isPlayerGrid(layout)).toBe(true);
	expect(layout.find(({ id }) => id === 'player-artwork')?.grid).toEqual({
		x: 0,
		y: 0,
		w: 30,
		h: 22
	});
	expect(layout.filter(({ grid }) => grid.y === 31).map(({ id }) => id)).toEqual([
		'player-repeat',
		'player-previous',
		'player-toggle',
		'player-next',
		'player-shuffle'
	]);
	expect(layout.filter(({ grid }) => grid.y === 36).map(({ id }) => id)).toEqual([
		'player-lyrics',
		'player-output',
		'player-queue'
	]);
	const rating = layout.find(({ id }) => id === 'player-rating')!;
	expect(rating.grid.x * 2 + rating.grid.w).toBe(30);
	expect(emptyGridSpace(layout, 2, 2)).toBeDefined();
	const play = layout.find(({ id }) => id === 'player-toggle')!;
	expect(gridFits(play.grid, layout)).toBe(false);
	expect(gridFits(play.grid, layout, play.id)).toBe(true);
	expect(toPlayerGrid(layout)).toEqual(layout);
	expect(toPlayerGrid(layout)[0].grid).not.toBe(layout[0].grid);
});

test('row conversion retains stacked content, relative column widths, custom text and hidden navigation', () => {
	const section = (id: string, fields: Partial<Section> = {}): Section => ({
		id,
		title: '',
		preview: true,
		...fields
	});
	const old = [
		section('player-artwork', { width: 3 }),
		section('player-text-2', {
			sameRow: true,
			width: 1,
			template: '{title} {artist}',
			maxLines: 2
		}),
		section('player-lyrics', { sameRow: true, stack: true, lyricsMode: 'sheet', padding: 7 }),
		section('player-close', { placement: 'hidden' })
	];
	const json = JSON.stringify(old);
	const converted = toPlayerGrid(old);
	expect(JSON.stringify(old)).toBe(json);
	expect(isPlayerGrid(converted)).toBe(true);
	const [art, text, lyrics] = old.slice(0, 3).map(({ id }) => converted.find((s) => s.id === id)!);
	expect(art.grid.w).toBeGreaterThan(text.grid.w);
	expect(text).toMatchObject({ template: '{title} {artist}', maxLines: 2 });
	expect(lyrics).toMatchObject({
		lyricsMode: 'sheet',
		padding: 7,
		grid: { x: text.grid.x, y: text.grid.y + text.grid.h, w: text.grid.w }
	});
	expect(converted.some(({ id }) => id === 'player-close')).toBe(false);
});

test('row-based drafts keep the old rounded row heights and column proportions', () => {
	const field = (name: string, options: Partial<Section> = {}): Section => ({
		id: 'player-' + name,
		title: '',
		preview: true,
		...options
	});
	const migrated = toPlayerGrid([
		field('close', { placement: 'header' }),
		field('artwork', { width: 3 }),
		field('lyrics', { sameRow: true, width: 1 }),
		field('title')
	]);
	// On the 15 × 20 grid the three rows occupied 3, 14 and 3 cells and the artwork spanned 11 columns.
	expect(migrated.map((s) => s.grid)).toEqual([
		{ x: 0, y: 0, w: 30, h: 6 },
		{ x: 0, y: 6, w: 22, h: 28 },
		{ x: 22, y: 6, w: 8, h: 28 },
		{ x: 0, y: 34, w: 30, h: 6 }
	]);
});

test('invalid coordinates and overlapping placements do not become an active grid', () => {
	const box = { x: 0, y: 0, w: 30, h: 40 };
	for (const invalid of [
		null,
		{},
		{ ...box, x: 1 },
		{ ...box, h: 0 },
		{ ...box, y: -1 },
		{ ...box, w: 2.5 }
	]) {
		expect(validGridRect(invalid)).toBe(false);
		expect(() => playerOptions({ grid: invalid }, true)).toThrow();
	}
	expect(playerOptions({ grid: box, iconMode: 'fill' }, true)).toEqual({
		grid: box,
		iconMode: 'fill'
	});
	const section = { title: '', preview: true, grid: box };
	expect(
		isPlayerGrid([
			{ ...section, id: 'player-artist' },
			{ ...section, id: 'player-title' }
		])
	).toBe(false);
});

test('large legacy layouts retain custom fields deterministically and reject an unrepresentable layout', () => {
	const old = Array.from({ length: 65 }, (_, i): Section => ({
		id: i ? 'player-text-' + (i + 1) : 'player-text',
		title: 'Line ' + i,
		template: 'Text {title} ' + i,
		preview: true
	}));
	const layout = toPlayerGrid(old);
	expect(isPlayerGrid(layout)).toBe(true);
	expect(toPlayerGrid(old)).toEqual(layout);
	expect(layout.map((s) => s.id)).toContain('player-close');
	expect(layout.filter((s) => s.id.startsWith('player-text')).map((s) => s.template)).toEqual(
		old.map((s) => s.template)
	);
	const oversized = Array.from({ length: 301 }, (_, i) => ({
		...old[0],
		id: 'player-text-' + (i + 2)
	}));
	const largerGrid = toPlayerGrid(oversized);
	expect(isPlayerGrid(largerGrid)).toBe(true);
	expect(largerGrid.filter((item) => item.id.startsWith('player-text'))).toHaveLength(301);
	expect(() =>
		toPlayerGrid(
			Array.from({ length: 1201 }, (_, i) => ({ ...old[0], id: 'player-text-' + (i + 2) }))
		)
	).toThrow('more items');
});
