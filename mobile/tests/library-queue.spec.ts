import { minimizePlayer } from './fixtures/minimizePlayer';
import { chooseOption } from './fixtures/inlineChoice';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test, type Page, type Route } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const server = 'https://queue.example/dn';
const wav = fileURLToPath(
	new URL('../../server/tests/fixtures/library/management_full.wav', import.meta.url)
);
const song = (id: string, title = id) => ({
	id,
	title,
	artist_name: 'Hear',
	album_title: 'The room',
	art_missing: true
});
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function connect(page: Page, prepare: (route: Route, url: URL) => Promise<unknown>) {
	const played: string[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const url = new URL(route.request().url()),
			path = url.pathname.split('/api/v3')[1];
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		expect(route.request().headers().authorization).toBe('Bearer fixture');
		if (path === '/me') return json({ id: 'owner', display_name: 'Owner', role: 'user' });
		if (path === '/me/section-prefs') return json({ pages: { home: [] } });
		if (path === '/home') return json({ sections: [], refreshing: false });
		if (path === '/library/albums') return json({ items: [], total: 0, next: null });
		if (path === '/library/stats') return json({ format_breakdown: { flac: 3 } });
		if (path === '/library/tracks') {
			if (url.searchParams.get('limit') === '200') {
				await prepare(route, url);
				return;
			}
			return json({ items: [song('Existing')], total: 1, next: null });
		}
		if (path.startsWith('/stream/local/')) {
			played.push(path.slice('/stream/local/'.length));
			return route.fulfill({ path: wav, contentType: 'audio/wav' });
		}
		if (path.includes('/lyrics')) return json({ items: [] });
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected request ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await button(page, 'Continue').click();
	await page.getByLabel('Username').fill('owner');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await button(page, 'Sign in').click();
	await button(page, 'Library').click();
	await button(page, 'Browse Tracks').click();
	await expect(button(page, 'Play Existing')).toBeVisible();
	return played;
}
for (const shuffle of [false, true]) {
	test(
		(shuffle ? 'shuffle' : 'play') +
			' builds the entire filtered local list before replacing the queue',
		async ({ page }) => {
			const calls: string[] = [];
			const played = await connect(page, async (route, url) => {
				const p = url.searchParams;
				expect(Object.fromEntries(p)).toMatchObject({
					q: 'Hear',
					sort: shuffle ? 'random' : 'date_added',
					order: shuffle ? 'asc' : 'desc',
					favorites: 'true',
					rating: '4',
					rating_mode: 'at_least',
					formats: 'flac',
					format_mode: 'with'
				});
				calls.push(p.get('after') || 'first');
				return route.fulfill({
					json: p.has('after')
						? { items: [song('Two'), song('Three')], total: 3, next: null }
						: { items: [song('One'), song('Two')], total: 3, next: 'opaque-seeded-cursor' }
				});
			});
			await button(page, 'Search tracks').click();
			await page.getByRole('searchbox', { name: 'Filter songs' }).fill('Hear');
			await button(page, 'Choose sort order').click();
			await chooseOption(page.getByLabel('Sort songs'), 'date_added');
			await button(page, 'Collection filters').click();
			await button(page, 'Favorites only').click();
			await page.getByText('Rating and format', { exact: true }).click();
			await chooseOption(page.getByLabel('Your rating'), '4');
			await page.getByRole('checkbox', { name: 'FLAC' }).check();
			await button(page, shuffle ? 'Shuffle all' : 'Play all').click();
			await expect.poll(() => played[0]).toBe('One');
			expect(calls).toEqual(['first', 'opaque-seeded-cursor']);
			await button(page, 'Show play queue').click();
			await expect(page.locator('[data-part="play-queue"] strong')).toHaveText([
				'One',
				'Two',
				'Three'
			]);
		}
	);
}

for (const issue of [
	'incomplete',
	'cursor loop',
	'changed total',
	'empty first window',
	'large metadata',
	'network error',
	'cancel',
	'navigation',
	'later play'
] as const) {
	test('queue preparation preserves existing playback on ' + issue, async ({ page }) => {
		let held: Route | undefined;
		const played = await connect(page, async (route, url) => {
			const next = url.searchParams.has('after');
			if (issue === 'empty first window')
				return route.fulfill({ json: { items: [], total: 2001, next: 'next' } });
			if (issue === 'large metadata')
				return route.fulfill({
					json: { items: [song('Huge', 'a'.repeat(1024 * 1024))], total: 1, next: null }
				});
			if (!next) return route.fulfill({ json: { items: [song('New')], next: 'next', total: 3 } });
			if (issue === 'incomplete')
				return route.fulfill({ json: { items: [song('Other')], next: null, total: 3 } });
			if (issue === 'cursor loop')
				return route.fulfill({ json: { items: [song('Other')], next: 'next', total: 3 } });
			if (issue === 'changed total')
				return route.fulfill({ json: { items: [song('Other')], next: null, total: 2 } });
			if (issue === 'network error') return route.fulfill({ status: 503, json: {} });
			held = route;
		});
		await button(page, 'Play Existing').click();
		await minimizePlayer(page);
		await button(page, 'Play all').click();
		if (issue === 'cancel' || issue === 'navigation' || issue === 'later play') {
			await expect.poll(() => Boolean(held)).toBe(true);
			await expect(page.getByRole('button', { name: 'Open player for Existing' })).toBeVisible();
			expect(played).toEqual(['Existing']);
			if (issue === 'cancel') await button(page, 'Cancel preparation').click();
			if (issue === 'navigation') await button(page, 'Back to Library').click();
			if (issue === 'later play') await button(page, 'Play Existing').click();
			await held!.fulfill({ json: { items: [song('Late'), song('Later')], total: 3, next: null } });
			if (issue === 'later play')
				await expect(page.getByRole('region', { name: 'Now playing', exact: true })).toBeVisible();
			else await expect(button(page, 'Open player for Existing')).toBeVisible();
		} else {
			const alert = page.getByRole('alert');
			await expect(alert).toBeVisible();
			if (issue === 'empty first window') await expect(alert).toContainText(/changed|incomplete/i);
			if (issue === 'large metadata') await expect(alert).toContainText('1 MiB');
		}
		if (issue !== 'later play') await button(page, 'Open player for Existing').click();
		await button(page, 'Show play queue').click();
		await expect(page.locator('[data-part="play-queue"] strong')).toHaveText(['Existing']);
		expect(played).not.toContain('New');
	});
}

test('an expired session stops the walk without starting a new queue', async ({ page }) => {
	let reads = 0;
	const played = await connect(page, async (route) => {
		reads++;
		if (reads === 1)
			return route.fulfill({ json: { items: [song('Unplayed')], next: 'next', total: 2 } });
		return route.fulfill({
			status: 401,
			json: { error: { code: 'UNAUTHORIZED', message: 'Session expired.' } }
		});
	});
	await button(page, 'Play all').click();
	await expect(page.getByLabel('Server address')).toBeVisible();
	expect(reads).toBe(2);
	expect(played).toEqual([]);
});
