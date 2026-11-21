import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Section } from '../src/lib/boards/layout';
import { GRID_ROWS, gridFits, toPlayerGrid } from '../src/lib/player/grid';
import { legacyRowDefaults } from '../src/lib/player/layout';
import {
	expandLegacyTrack,
	flattenPlayerRows,
	isPlayerSlot,
	nextSlotId,
	playerRows
} from '../src/lib/player/composition';
import { exportPlayerStyle, importPlayerStyle } from '../src/lib/player/playerStyle';
import { emptyBoardRead } from './fixtures/emptyBoardRead';

const cell = (id: string, options: Partial<Section> = {}): Section => ({
	id,
	preview: true,
	title: '',
	...options
});
test('player slots, independent metadata and field options survive layout transfer', () => {
	const draft = flattenPlayerRows([
		[
			cell('player-text', {
				maxLines: 2,
				reserveLines: true,
				padding: 0,
				vAlign: 'end',
				template: '{artist}'
			}),
			cell('player-slot-1'),
			cell('player-next', { width: 9, icon: 'circle-play', iconSize: 38, showLabel: false })
		],
		[cell('player-slot-2')]
	]);
	expect(importPlayerStyle(exportPlayerStyle(draft))).toEqual(draft);
	expect(nextSlotId(draft)).toBe('player-slot-3');
	expect(isPlayerSlot('player-slot-02')).toBe(false);
	expect(
		playerRows(
			flattenPlayerRows([Array.from({ length: 7 }, (_, i) => cell('player-slot-' + (i + 1)))])
		).map((r) => r.length)
	).toEqual([6, 1]);
	expect(legacyRowDefaults().map((s) => s.id)).toContain('player-album');
	expect(expandLegacyTrack([cell('player-track', { preview: false })]).map((s) => s.id)).toEqual([
		'player-title',
		'player-artist'
	]);
	const custom = [
		cell('player-slot-1'),
		cell('player-track', { sameRow: true, title: 'My metadata' })
	];
	expect(expandLegacyTrack(custom)).toEqual(custom);
	const base = JSON.parse(exportPlayerStyle([cell('player-title')]));
	for (const option of [
		{ padding: -1 },
		{ padding: 33 },
		{ vAlign: 'left' },
		{ icon: 'unknown' },
		{ iconSize: 9 },
		{ showLabel: 'yes' },
		{ maxLines: 9 },
		{ reserveLines: 1 },
		{ width: 13 }
	])
		expect(() =>
			importPlayerStyle(JSON.stringify({ ...base, sections: [{ ...base.sections[0], ...option }] }))
		).toThrow();
});

test('six live player columns fit 320px and action, alignment and text settings take effect', async ({
	page
}) => {
	const server = 'https://renderer.example/dn',
		trackTitle = 'Road Song',
		album = 'Low Tide';
	const tracks = [
		{
			id: 'one',
			title: trackTitle,
			artist_name: 'South',
			album_id: 'a',
			album_title: album,
			disc_number: 1,
			track_number: 1,
			duration_seconds: 10,
			art_missing: true
		}
	];
	const sections = flattenPlayerRows([
		[cell('player-title', { padding: 0, maxLines: 1, icon: 'default', showLabel: false })],
		[
			cell('player-artist', {
				padding: 0,
				maxLines: 2,
				reserveLines: true,
				icon: 'user-round',
				iconSize: 26
			})
		],
		[
			cell('player-text', {
				template: 'Detail · {artist}',
				icon: 'type',
				showLabel: false,
				width: 1,
				minHeight: 120,
				padding: 8,
				vAlign: 'end'
			}),
			cell('player-album', {
				width: 3,
				vAlign: 'start',
				icon: 'album',
				iconSize: 18,
				showLabel: false
			})
		],
		[
			'player-shuffle',
			'player-previous',
			'player-toggle',
			'player-next',
			'player-repeat',
			'player-slot-1'
		].map((id) =>
			cell(id, {
				padding: 0,
				...(id === 'player-toggle' ? { icon: 'circle-play', iconSize: 32, showLabel: false } : {}),
				...(id === 'player-next' ? { icon: 'none', showLabel: true } : {})
			})
		),
		[cell('player-slot-2', { minHeight: 26 })]
	]);
	const audio = await readFile(
		new URL('../android/app/src/androidTest/assets/offline/silence.mp3', import.meta.url)
	);
	await page.addInitScript(
		({ server, sections }) =>
			localStorage.setItem(
				'dn.mobile.layout.v1.' + JSON.stringify([server, 'listener', 'player']),
				JSON.stringify(sections)
			),
		{ server, sections }
	);
	await page.route(server + '/api/v3/**', async (route) => {
		const path = new URL(route.request().url()).pathname.split('/api/v3')[1];
		if (path === '/auth/providers') return route.fulfill({ json: { local: true, oidc: false } });
		if (path === '/auth/login') return route.fulfill({ json: { token: 'fixture' } });
		if (path === '/me')
			return route.fulfill({ json: { id: 'listener', display_name: 'Listener', role: 'user' } });
		if (path === '/library/albums')
			return route.fulfill({
				json: {
					items: [{ id: 'a', title: album, artist_name: 'South', art_missing: true }],
					next: null
				}
			});
		if (path === '/library/albums/match/a' || path === '/library/tracks')
			return route.fulfill({ json: { items: tracks, total: 1 } });
		if (path.startsWith('/stream/local/'))
			return route.fulfill({ body: audio, contentType: 'audio/mpeg' });
		if (await emptyBoardRead(route)) return;
		return route.fulfill({ status: 404, json: {} });
	});
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page
		.getByRole('button', { name: /Low Tide/ })
		.first()
		.click();
	await page.getByRole('button', { name: 'Play album' }).click();
	const live = page.getByRole('region', { name: 'Now playing' });
	const at = (id: string) => live.locator('[data-section-id="' + id + '"]');
	await expect(at('player-toggle').getByRole('button', { name: 'Pause' })).toBeVisible();
	await expect(at('player-toggle').locator('[data-player-icon="circle-play"]')).toHaveAttribute(
		'data-playback',
		'pause'
	);
	await at('player-toggle').getByRole('button', { name: 'Pause' }).click();
	await expect(at('player-toggle').locator('[data-player-icon="circle-play"]')).toHaveAttribute(
		'data-playback',
		'play'
	);
	await expect(at('player-next').getByRole('button', { name: 'Next track' })).toHaveText('Next');
	await expect(at('player-next').locator('svg')).toHaveCount(0);
	await expect(at('player-toggle').locator('svg')).toHaveCSS('width', '32px');
	await expect(at('player-title').getByRole('heading', { name: trackTitle })).toBeVisible();
	await expect(at('player-title').locator('svg')).toHaveCount(0);
	await expect(at('player-artist').locator('[data-player-icon="user-round"] svg')).toHaveCSS(
		'width',
		'26px'
	);
	await expect(at('player-artist').getByText('South', { exact: true })).toBeVisible();
	const albumLink = at('player-album').getByRole('button', { name: 'Open album ' + album });
	await expect(albumLink).toBeVisible();
	await expect(albumLink.locator('[data-player-icon="album"] svg')).toHaveCSS('height', '18px');
	const fit = await live
		.locator('.player-frame')
		.evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--player-fit')) || 1);
	expect((await albumLink.boundingBox())!.height / fit).toBeGreaterThanOrEqual(43.9);
	await expect(albumLink.locator('.lines')).toHaveCount(0);
	await expect(at('player-text').getByRole('img', { name: 'Detail · South' })).toBeVisible();
	await expect(at('player-text').locator('.lines')).toHaveCount(0);
	const title = await at('player-title').boundingBox(),
		artist = await at('player-artist').boundingBox();
	expect(Math.abs(title!.y + title!.height - artist!.y)).toBeLessThan(1);
	const lines = await at('player-artist')
		.locator('.lines')
		.evaluate((el) => ({
			height: el.getBoundingClientRect().height,
			line: getComputedStyle(el).lineHeight
		}));
	// Computed min-block-size materializes reserved line boxes even when this artist fits on one line.
	expect(lines.height / fit).toBeGreaterThan(34);
	const weighted = await at('player-text').boundingBox(),
		wide = await at('player-album').boundingBox();
	expect(wide!.width).toBeGreaterThan(weighted!.width * 2.8);
	const bottom = await at('player-text').locator('.content').boundingBox(),
		top = await at('player-album').locator('.content').boundingBox();
	expect(bottom!.y).toBeGreaterThan(top!.y + 45 * fit);
	await expect(at('player-text').locator('.content')).toHaveCSS('padding', '8px');
	const buttons = live.locator('[data-part="player-row"]').nth(3).getByRole('button');
	await expect(buttons).toHaveCount(5);
	for (const button of await buttons.all()) {
		const box = (await button.boundingBox())!;
		expect(box.width / fit).toBeGreaterThanOrEqual(43.9);
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(320);
	}
	expect((await at('player-slot-2').boundingBox())!.height).toBe(26);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
	await live.getByRole('button', { name: 'Player settings' }).click();
	const sample = page.locator('[data-part="sample-player"]');
	await expect(
		sample.locator('[data-section-id="player-artist"] [data-player-icon="user-round"] svg')
	).toHaveCSS('width', '26px');
	await expect(sample.locator('[data-section-id="player-text"] [role="img"]')).toHaveAttribute(
		'aria-label',
		'Detail · Artist Name'
	);
	// Old spacer fields become unoccupied cells. The artist's custom placement and the
	// empty region survive the conversion without putting a placeholder on the canvas.
	await expect(sample.locator('[data-section-id="player-slot-2"]')).toHaveCount(0);
	const migrated = toPlayerGrid(sections);
	const spacer = migrated.find((s) => s.id === 'player-slot-2')!.grid;
	expect(
		gridFits(
			spacer,
			migrated.filter((s) => !isPlayerSlot(s.id))
		)
	).toBe(true);
	await expect(sample.locator('[data-section-id="player-title"] .lines')).toHaveCSS(
		'-webkit-line-clamp',
		'1'
	);
	await expect(sample.locator('[data-section-id="player-toggle"] .content svg')).toHaveCSS(
		'width',
		'32px'
	);
	await expect(sample.locator('[data-section-id="player-text"] .content')).toHaveCSS(
		'padding',
		'8px'
	);
	const editorGrid = (await sample.locator('[data-player-grid]').boundingBox())!;
	const last = (await sample.locator('[data-section-id="player-repeat"]').boundingBox())!;
	expect(last.y + last.height).toBeLessThanOrEqual(
		editorGrid.y + (editorGrid.height * spacer.y) / GRID_ROWS + 1
	);
});
