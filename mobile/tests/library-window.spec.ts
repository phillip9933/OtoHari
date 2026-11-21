import { playerWithoutFeedback } from './fixtures/playerWithoutFeedback';
import { expect, test, type Page, type Route } from '@playwright/test';
import { silentWav } from './fixtures/silentWav';
import { emptyBoardRead } from './fixtures/emptyBoardRead';

const origin = 'https://catalog.example/dn';
const wav = silentWav(30);
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const total = 76_003;
const cursor = (i: number) => 'opaque + seed/76&after=' + i;
const num = (i: number, shuffle: boolean) => (shuffle ? (i * 7919) % total : i);
function song(n: number, shuffle: boolean) {
	const id = 'song-' + num(n, shuffle);
	return {
		id,
		title: 'Record ' + num(n, shuffle),
		artist_name: 'Resident',
		album_title: 'Album',
		art_missing: true
	};
}
function pageData(start: number, size: number, shuffle: boolean) {
	const end = Math.min(total, start + size);
	return {
		items: Array.from({ length: end - start }, (_, i) => song(i + start, shuffle)),
		total,
		next: end < total ? cursor(end) : null
	};
}

async function setup(
	page: Page,
	shuffle: boolean,
	load?: (route: Route, n: number) => Promise<void>
) {
	await playerWithoutFeedback(page, origin, 'owner');
	const after: string[] = [],
		played: string[] = [];
	await page.addInitScript(() => {
		const Original = window.Audio;
		window.Audio = class extends Original {
			constructor(...args: ConstructorParameters<typeof Original>) {
				super(...args);
				document.addEventListener('fixture-song-ended', () => {
					this.pause();
					this.dispatchEvent(new Event('ended'));
				});
			}
		};
	});
	await page.route(origin + '/api/v3/**', async (route) => {
		const url = new URL(route.request().url()),
			path = url.pathname.split('/api/v3')[1],
			q = url.searchParams;
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		expect(route.request().headers().authorization).toBe('Bearer fixture');
		expect(url.search).not.toContain('fixture');
		if (path === '/me') return json({ id: 'owner', display_name: 'Owner', role: 'user' });
		if (path === '/me/section-prefs') return json({ pages: { home: [] } });
		if (path === '/home') return json({ sections: [], refreshing: false });
		if (path === '/library/albums') return json({ items: [], total: 0, next: null });
		if (path === '/library/stats') return json({ format_breakdown: { flac: total } });
		if (path === '/library/tracks') {
			const size = Number(q.get('limit'));
			if (size !== 200 && size !== 100)
				return json({ items: [song(0, false)], total: 1, next: null });
			if (shuffle) {
				expect(q.get('sort')).toBe('random');
				expect(q.get('order')).toBe('asc');
			}
			const start = q.has('after') ? Number(q.get('after')?.split('=').pop()) : 0;
			expect(q.get('after')).toBe(start ? cursor(start) : null);
			expect(size).toBe(start ? 100 : 200);
			after.push(q.get('after') ?? 'first');
			if (start && load) return load(route, start);
			return json(pageData(start, size, shuffle));
		}
		if (path.startsWith('/stream/local/')) {
			played.push(path.split('/').pop()!);
			return route.fulfill({ body: wav, contentType: 'audio/wav' });
		}
		if (path.includes('/lyrics')) return json({ items: [] });
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected request ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(origin);
	await button(page, 'Continue').click();
	await page.getByLabel('Username').fill('owner');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await button(page, 'Sign in').click();
	await button(page, 'Library').click();
	await button(page, 'Browse Tracks').click();
	await expect(button(page, 'Play all')).toBeEnabled();
	await button(page, shuffle ? 'Shuffle all' : 'Play all').click();
	await expect(button(page, 'Show play queue')).toBeVisible();
	await button(page, 'Show play queue').click();
	return { after, played, queue: page.locator('[data-part=play-queue]') };
}

test('76,003 ordered tracks play beyond successive pages with a bounded queue and global positions', async ({
	page
}) => {
	const { after, played, queue } = await setup(page, false);
	await expect(queue.getByText('Tracks 1–200 of 76,003')).toBeVisible();
	expect(after).toEqual(['first']);
	for (const end of [200, 300, 400]) {
		await queue
			.getByRole('button', { name: new RegExp('Record ' + (end - 1) + ' Resident$') })
			.click();
		await expect(
			queue.getByText('Tracks ' + (end - 50) + '–' + (end + 100) + ' of 76,003')
		).toBeVisible();
		await expect(queue.locator('li')).toHaveCount(151);
		await expect(queue.locator('[aria-current=true]')).toContainText('Record ' + (end - 1));
		await page.evaluate(() => document.dispatchEvent(new Event('fixture-song-ended')));
		await expect(queue.locator('[aria-current=true]')).toContainText('Record ' + end + 'Resident');
		expect(played.at(-1)).toBe('song-' + end);
	}
	expect(after).toEqual(['first', cursor(200), cursor(300), cursor(400)]);
});

test('a fresh library shuffle rejects a repeated first page and keeps its continuation', async ({
	page
}) => {
	const first = await setup(page, true);
	const rows = (queue: typeof first.queue) => queue.locator('li strong');
	await expect(rows(first.queue)).toHaveCount(200);
	const before = await rows(first.queue).allTextContents();
	const next = await setup(page, true);
	await expect(rows(next.queue)).toHaveCount(200);
	const after = await rows(next.queue).allTextContents();
	expect(after).not.toEqual(before);
	expect([...after].sort()).toEqual([...before].sort());
	await next.queue.getByRole('button', { name: new RegExp(after.at(-1) + ' Resident$') }).click();
	await expect(next.queue.getByText('Tracks 150–300 of 76,003')).toBeVisible();
	expect(next.after).toEqual(['first', cursor(200)]);
});

test('whole-library shuffle preserves the server seed after network failure, then detaches on an explicit edit', async ({
	page
}) => {
	let failures = 0;
	const { after, queue } = await setup(page, true, async (route, start) => {
		if (failures++ < 2) {
			await route.fulfill({ status: 503, json: {} });
			return;
		}
		await route.fulfill({ json: pageData(start, 100, true) });
	});
	await expect(queue.getByText('Record ' + num(180, true), { exact: true })).toBeVisible();
	await queue
		.getByRole('button', { name: new RegExp('Record ' + num(199, true) + ' Resident$') })
		.click();
	await expect(button(page, 'Retry library queue')).toBeVisible();
	await expect.poll(() => failures).toBe(2);
	await button(page, 'Retry library queue').click();
	await expect(queue.getByText('Tracks 150–300 of 76,003')).toBeVisible();
	expect(after).toEqual(['first', cursor(200), cursor(200), cursor(200)]);
	await button(page, 'Edit queue').click();
	await expect(
		queue.getByText(/Removing or reordering original tracks keeps only the 151/)
	).toBeVisible();
	await button(page, 'Remove Record ' + num(150, true) + ' from queue').click();
	await expect(queue.locator('li')).toHaveCount(150);
	await expect(queue.getByText(/of 76,003/)).toHaveCount(0);
	await queue
		.getByRole('button', { name: new RegExp('Record ' + num(299, true) + ' Resident$') })
		.click();
	expect(after).toHaveLength(4);
});

test('an Up Next pick from a future page preserves the full library and both occurrences', async ({
	page
}) => {
	const { queue } = await setup(page, false);
	await page.route(
		(url) => url.pathname.endsWith('/library/tracks') && url.searchParams.has('q'),
		(route) => route.fulfill({ json: { items: [{ ...song(199, false), genre: 'Jazz' }] } })
	);
	await page.route(origin + '/api/v3/discover/radio/plan', (route) =>
		route.fulfill({
			json: {
				tracks: [
					{
						in_library: true,
						local_file_id: 'song-200',
						track_name: 'Picked early',
						artist_name: 'Resident'
					}
				]
			}
		})
	);
	await button(page, 'Similar tracks').click();
	await button(page, 'Add to Up Next · Picked early').click();
	await button(page, 'Close Similar tracks').click();
	await expect(queue.locator('strong').nth(1)).toHaveText('Picked early');
	await expect(queue.getByText('Tracks 1–200 of 76,003')).toBeVisible();
	await queue.getByRole('button', { name: /Record 199 Resident$/ }).click();
	await expect(queue.getByText('Tracks 150–300 of 76,003')).toBeVisible();
	await expect(queue.getByRole('button', { name: /Record 200 Resident$/ })).toBeVisible();
});

test('pausing at the boundary prevents a delayed page from restarting audio', async ({ page }) => {
	let held: Route | undefined;
	const { played, queue } = await setup(page, false, async (route) => {
		held = route;
	});
	await queue.getByRole('button', { name: /Record 199 Resident$/ }).click();
	await expect.poll(() => !!held).toBe(true);
	await button(page, 'Hide play queue').click();
	await page.evaluate(() => document.dispatchEvent(new Event('fixture-song-ended')));
	await expect(button(page, 'Pause')).toBeVisible();
	await button(page, 'Pause').click();
	await held!.fulfill({ json: pageData(200, 100, false) });
	await expect(button(page, 'Play')).toBeVisible();
	await button(page, 'Show play queue').click();
	await expect(queue.getByText('Tracks 150–300 of 76,003')).toBeVisible();
	await expect(queue.locator('[aria-current=true]')).toContainText('Record 199');
	expect(played).not.toContain('song-200');
});
