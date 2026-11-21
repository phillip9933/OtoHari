import { expect, test, type Page } from '@playwright/test';
import { GRID_COLUMNS, GRID_ROWS } from '../src/lib/player/grid';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';

async function openGrid(page: Page) {
	const server = 'https://grid-zoom.example';
	await page.addInitScript((server) => {
		const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'listener', 'player']);
		localStorage.setItem(
			key,
			JSON.stringify({
				version: 3,
				sections: [
					{ id: 'player-title', title: '', preview: true, grid: { x: 12, y: 16, w: 6, h: 5 } }
				]
			})
		);
	}, server);
	await page.route(server + '/api/v3/**', async (route) => {
		const responses: Record<string, unknown> = {
			'/auth/providers': { local: true, oidc: false },
			'/auth/login': { token: 'fixture' },
			'/me': { id: 'listener', role: 'user', display_name: 'Listener' }
		};
		const path = new URL(route.request().url()).pathname.slice('/api/v3'.length);
		if (await emptyBoardRead(route)) return;
		expect(path in responses).toBe(true);
		await route.fulfill({ json: responses[path] });
	});
	await localSignIn(page, server);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Now Playing layout' }).click();
	const stage = page.locator('[data-part=layout-editor] .stage');
	await expect(stage.locator('[data-player-grid]')).toBeVisible();
	return stage;
}

test('pinch magnifies around the fingers, two-finger panning follows them, and fitting restores the canvas', async ({
	page
}) => {
	const stage = await openGrid(page);
	const grid = stage.locator('[data-player-grid]');
	const box = (await grid.boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	const cdp = await page.context().newCDPSession(page);
	const points = (x: number, y: number, distance: number) => [
		{ x: x - distance / 2, y, id: 1 },
		{ x: x + distance / 2, y, id: 2 }
	];
	try {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: points(x, y, 50)
		});
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: points(x, y, 100)
		});
		await expect(page.getByRole('button', { name: 'Fit grid to screen' })).toHaveText('200%');
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: points(x - 15, y + 18, 100)
		});
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		const enlarged = (await grid.boundingBox())!;
		expect(enlarged.width / box.width).toBeCloseTo(2);
		expect(enlarged.height / box.height).toBeCloseTo(2);
		expect(Math.abs(enlarged.x + enlarged.width / 2 - (x - 15))).toBeLessThan(2);
		expect(Math.abs(enlarged.y + enlarged.height / 2 - (y + 18))).toBeLessThan(2);
		const scrollBefore = await stage.evaluate((el) => el.scrollTop);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
		for (let step = 1; step <= 5; step++) {
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x, y: y - step * 9 }]
			});
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect.poll(() => stage.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrollBefore + 8);
	} finally {
		await cdp.detach();
	}
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Undo layout edit' })).toBeDisabled();
	await page.getByRole('button', { name: 'Fit grid to screen' }).click();
	await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
	const restored = (await grid.boundingBox())!;
	expect(restored.x).toBeCloseTo(box.x);
	expect(restored.y).toBeCloseTo(box.y);
	expect(restored.width).toBeCloseTo(box.width);
});

test('zoomed drag and resize snap by displayed cell size and preview uses the live dimensions', async ({
	page
}) => {
	const stage = await openGrid(page);
	const grid = stage.locator('[data-player-grid]');
	const tile = grid.locator('[data-grid-handle=move][data-field-id=player-title]');
	await page.getByRole('button', { name: 'Zoom in' }).click();
	const bounds = (await grid.boundingBox())!;
	const box = (await tile.boundingBox())!;
	const x = box.x + box.width / 2,
		y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.waitForTimeout(450);
	await page.mouse.move(
		x + (2 * bounds.width) / GRID_COLUMNS,
		y + (3 * bounds.height) / GRID_ROWS,
		{ steps: 4 }
	);
	await page.mouse.up();
	const moved = (await tile.boundingBox())!;
	expect(Math.round(((moved.x - bounds.x) * GRID_COLUMNS) / bounds.width)).toBe(14);
	expect(Math.round(((moved.y - bounds.y) * GRID_ROWS) / bounds.height)).toBe(19);
	const handle = (await tile.locator('[data-grid-handle=resize]').boundingBox())!;
	const cornerX = handle.x + handle.width / 2,
		cornerY = handle.y + handle.height / 2;
	await page.mouse.move(cornerX, cornerY);
	await page.mouse.down();
	await page.mouse.move(
		cornerX + (2 * bounds.width) / GRID_COLUMNS,
		cornerY + bounds.height / GRID_ROWS,
		{ steps: 4 }
	);
	await page.mouse.up();
	const resized = (await tile.boundingBox())!;
	expect(Math.round((resized.width * GRID_COLUMNS) / bounds.width)).toBe(8);
	expect(Math.round((resized.height * GRID_ROWS) / bounds.height)).toBe(6);
	await page.getByRole('button', { name: 'Preview current draft' }).click();
	const draft = page.locator('[data-part=draft-player]');
	expect(await draft.evaluate((el) => getComputedStyle(el).getPropertyValue('--grid-zoom'))).toBe(
		''
	);
	await page.getByRole('button', { name: 'Back to editing' }).click();
	await expect(page.getByRole('button', { name: 'Fit grid to screen' })).toHaveText('150%');
});
