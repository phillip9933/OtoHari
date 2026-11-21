import { playerWithoutFeedback } from './fixtures/playerWithoutFeedback';
import { chooseOption } from './fixtures/inlineChoice';
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { touchRange } from './fixtures/touchRange';
import { localSignIn } from './fixtures/localSignIn';
import { seedOfflineMusic } from './fixtures/offlineMusic';
const server = 'https://large-library.example',
	wav = fileURLToPath(
		new URL('../../server/tests/fixtures/library/management_full.wav', import.meta.url)
	);
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const index = (page: Page) => page.locator('[data-part=category-items]:visible');
const label = (n: number) => String(n).padStart(5, '0');
test('the alphabet jumps across opaque pages and stays available for downloaded albums', async ({
	page
}) => {
	await connect(page, 600);
	const requests: string[] = [];
	await page.route(server + '/api/v3/library/albums?**', async (r) => {
		const q = new URL(r.request().url()).searchParams;
		const start = Number(q.get('after')?.split('/')[1]) || 0;
		expect(q.get('after')).toBe(start ? 'page/' + start : null);
		requests.push(q.get('after') ?? 'first');
		const end = Math.min(600, start + Number(q.get('limit')));
		return r.fulfill({
			json: {
				items: Array.from({ length: end - start }, (_, n) => ({
					id: 'a' + (start + n),
					title: (start + n < 520 ? 'Archive' : 'Zen') + ' ' + label(start + n),
					artist_name: 'Band',
					art_missing: true
				})),
				total: 600,
				next: end < 600 ? 'page/' + end : null
			}
		});
	});
	await button(page, 'Browse Albums').click();
	const rail = page.getByRole('slider', { name: 'Jump to letter' });
	await rail.focus();
	await rail.press('Z');
	await expect(button(page, 'Zen 00520')).toBeInViewport();
	expect(requests).toContain('page/430');
	await rail.press('Q');
	await expect(page.getByText('No albums starting with Q.')).toBeVisible();
	await button(page, 'Back to Library').click();
	await seedOfflineMusic(
		page,
		server,
		'listener',
		true,
		Array.from({ length: 100 }, (_, i) => ({
			origin: 'downloaded' as const,
			track: {
				id: 'local' + i,
				title: 'Music ' + i,
				artist: 'Band',
				album: (i < 90 ? 'Archive' : 'Zen') + ' ' + label(i),
				albumId: 'l' + i,
				streamUrl: '/api/v3/stream/local/local' + i
			}
		}))
	);
	await button(page, 'Browse Albums').click();
	await rail.focus();
	await rail.press('Z');
	await expect(button(page, 'Zen 00090')).toBeInViewport();
});
async function connect(page: Page, size = 3025) {
	await playerWithoutFeedback(page, server, 'listener');
	const requests: URL[] = [],
		streams: string[] = [];
	let fail = 0;
	let deferred: { entered: () => void; gate: Promise<void> } | undefined;
	const song = (i: number) => ({
		id: 'f' + i,
		title: 'Track ' + label(i),
		artist_name: 'Ensemble',
		album_id: 'a' + i,
		album_title: 'Album ' + label(i),
		art_missing: true,
		year: 2000 + (i % 20)
	});
	await page.route(server + '/api/v3/**', async (route) => {
		const u = new URL(route.request().url()),
			p = u.pathname.slice(7),
			q = u.searchParams;
		const send = (json: unknown) => route.fulfill({ json });
		if (p === '/auth/providers') return send({ local: true, oidc: false });
		if (p === '/auth/login') return send({ token: 'demo' });
		if (p === '/me') return send({ id: 'listener', display_name: 'Listener' });
		if (p === '/me/section-prefs') return send({ pages: { home: [] } });
		if (p === '/home') return send({ sections: [], refreshing: false });
		if (['/library/tracks', '/library/albums', '/library/artists'].includes(p)) {
			requests.push(u);
			if (deferred && q.has('after')) {
				const held = deferred;
				deferred = undefined;
				held.entered();
				await held.gate;
			}
			if (fail && p === '/library/tracks' && q.get('limit') === '30' && q.has('after')) {
				fail--;
				return route.fulfill({
					status: 503,
					json: { error: { message: 'Temporarily unavailable' } }
				});
			}
			const start = Number(q.get('after')) || 0,
				limit = Number(q.get('limit')) || 30;
			const count = Math.max(0, Math.min(size - start, limit));
			const items = Array.from({ length: count }, (_, j) => {
				const i = start + j;
				return p.endsWith('albums')
					? { id: 'a' + i, title: 'Album ' + label(i), artist_name: 'Ensemble', art_missing: true }
					: p.endsWith('artists')
						? { id: 'r' + i, name: 'Artist ' + label(i), album_count: 0 }
						: song(i);
			});
			return send({
				items,
				next: start + count < size ? String(start + count) : null,
				total: size
			});
		}
		if (p.startsWith('/library/albums/match/')) return send({ items: [], total: 0 });
		if (p.includes('/artwork')) return route.fulfill({ status: 404 });
		if (p.startsWith('/stream/local/')) {
			streams.push(p.split('/').at(-1)!);
			return route.fulfill({ path: wav, contentType: 'audio/wav' });
		}
		if (await emptyBoardRead(route)) return;
		throw Error(p);
	});
	await localSignIn(page, server);
	await button(page, 'Library').click();
	return {
		requests,
		streams,
		failNext: () => fail++,
		holdNext: () => {
			let entered!: () => void, release!: () => void;
			const arrival = new Promise<void>((r) => (entered = r));
			deferred = { entered, gate: new Promise<void>((r) => (release = r)) };
			return { arrival, release };
		}
	};
}
async function step(page: Page, before: number) {
	const main = page.locator('main');
	await main.hover();
	await page.mouse.wheel(0, 250_000);
	await expect
		.poll(async () => Number(await index(page).getAttribute('data-loaded')), {
			timeout: 3500,
			intervals: [18, 35, 60]
		})
		.toBeGreaterThan(before)
		.catch(async (cause) => {
			throw Error(
				String(cause) +
					' ' +
					JSON.stringify(
						await main.evaluate((m) => ({
							y: m.scrollTop,
							h: m.scrollHeight,
							view: m.clientHeight,
							rect: m.querySelector('[data-part=category-items]')?.getBoundingClientRect(),
							more: m.querySelector('.more-page')?.getBoundingClientRect(),
							items: m.querySelectorAll('.entry').length
						}))
					)
			);
		});
}
test('auto paging has a manual retry, never loops at rest and preserves filtered search', async ({
	page
}) => {
	const s = await connect(page);
	await button(page, 'Browse Tracks').click();
	await expect(index(page)).toHaveAttribute('data-loaded', '30');
	await button(page, 'Search tracks').click();
	await page.getByRole('searchbox').fill('Track');
	await expect
		.poll(() => s.requests.filter((u) => u.searchParams.get('q') === 'Track').length)
		.toBe(1);
	s.failNext();
	await page.locator('main').hover();
	await page.mouse.wheel(0, 250_000);
	await expect(page.getByRole('alert')).toBeVisible();
	await page.locator('main').evaluate((m) => {
		m.scrollTop -= 15;
		m.scrollTop += 15;
	});
	await expect(index(page)).toHaveAttribute('data-loaded', '30');
	expect(s.requests.filter((u) => u.searchParams.has('after'))).toHaveLength(1);
	await button(page, 'Retry').click();
	await expect(index(page)).toHaveAttribute('data-loaded', '60');
	await expect(button(page, 'More songs')).toBeVisible();
	const cursorReads = s.requests.filter((u) => u.searchParams.has('after'));
	expect(cursorReads.map((u) => u.searchParams.get('after'))).toEqual(['30', '30']);
	expect(cursorReads.every((u) => u.searchParams.get('q') === 'Track')).toBe(true);
});
test('a long scrolling and selecting session mounts a bounded number of track rows and plays through the filtered cursor', async ({
	page
}, info) => {
	test.setTimeout(90000);
	await page.setViewportSize({ width: 320, height: 680 });
	const s = await connect(page);
	await button(page, 'Browse Tracks').click();
	const shelf = index(page),
		main = page.locator('main');
	await expect(shelf).toHaveAttribute('data-loaded', '30');
	await button(page, 'Search tracks').click();
	await page.getByRole('searchbox').fill('Track');
	await expect.poll(() => s.requests.some((u) => u.searchParams.get('q') === 'Track')).toBe(true);
	await page.locator('[data-browse-index="0"]:visible .item').press('Shift+Space');
	const counts: number[] = [],
		times: number[] = [];
	const profile = await page.evaluateHandle(() => {
		const longTasks: number[] = [];
		const o = new PerformanceObserver((list) => {
			for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
		});
		o.observe({ type: 'longtask' });
		return { longTasks, observer: o };
	});
	for (let n = 30; n < 2430; n += 30) {
		const start = Date.now();
		await step(page, n);
		times.push(Date.now() - start);
		if (n % 150 === 0) counts.push(await shelf.locator('.entry').count());
	}
	const client = await profile.evaluate((x) => {
		x.observer.disconnect();
		return {
			longTasksMs: x.longTasks,
			buttons: document.querySelectorAll('[data-part=category-items] button').length
		};
	});
	await profile.dispose();
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	expect(Math.max(...counts)).toBeLessThan(80);
	const allLoaded = await shelf.getAttribute('data-loaded');
	await button(page, 'Select loaded').click();
	await expect(page.getByText(allLoaded + ' selected', { exact: true })).toBeVisible();
	await main.evaluate((m) => (m.scrollTop = 0));
	await expect(button(page, 'Select Track 00000')).toHaveAttribute('aria-pressed', 'true');
	await button(page, 'Cancel selection').click();
	const firstHeight = await shelf
		.locator('[data-browse-index="0"]')
		.evaluate(
			(e) =>
				e.getBoundingClientRect().height + parseFloat(getComputedStyle(e.parentElement!).rowGap)
		);
	await main.evaluate((m, y) => (m.scrollTop = y), firstHeight * 2380);
	await expect(button(page, 'Play Track 02385')).toBeVisible();
	const offset = await main.evaluate((m) => m.scrollTop);
	await button(page, 'Play Track 02385').click();
	await expect(page.getByRole('region', { name: 'Now playing', exact: true })).toBeVisible();
	await expect.poll(() => s.streams[0]).toBe('f2385');
	await button(page, 'Show play queue').click();
	await expect(page.locator('[data-part=play-queue] strong')).toContainText(['Track 02385']);
	const loadedPages = s.requests.filter((u) => u.searchParams.get('limit') === '30').length;
	await button(page, 'Close player').click();
	await expect(button(page, 'Play Track 02385')).toBeFocused();
	expect(Math.abs((await main.evaluate((m) => m.scrollTop)) - offset)).toBeLessThan(5);
	await expect(page.getByRole('searchbox')).toHaveValue('Track');
	expect(s.requests.filter((u) => u.searchParams.get('limit') === '30')).toHaveLength(loadedPages);
	const output = info.outputPath('scroll-profile.json');
	await writeFile(
		output,
		JSON.stringify({
			records: Number(allLoaded),
			viewport: '320x680',
			mountedRows: counts,
			pageToPaintMs: times,
			...client
		})
	);
	await info.attach('scroll-profile', { path: output, contentType: 'application/json' });
});
test('six album and artist columns fit beside the alphabet on a narrow phone at every theme spacing', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await connect(page, 180);
	for (const category of ['Albums', 'Artists']) {
		await button(page, 'Browse ' + category).tap();
		await button(page, 'Collection options').tap();
		await chooseOption(page.getByLabel('Grid columns'), '6');
		await button(page, 'Collection options').tap();
		const rail = page.getByRole('slider', { name: 'Jump to letter' });
		await expect(rail).toBeVisible();
		for (let spacing = 8; spacing <= 24; spacing++) {
			await page.evaluate(
				(n) => document.documentElement.style.setProperty('--gap', n + 'px'),
				spacing
			);
			const first = (await index(page).locator('[data-browse-index="0"] .item').boundingBox())!;
			const last = (await index(page).locator('[data-browse-index="5"] .item').boundingBox())!;
			const alphabet = (await rail.boundingBox())!;
			expect(first.width).toBeGreaterThanOrEqual(44);
			expect(last.y).toBe(first.y);
			expect(last.x + last.width).toBeLessThanOrEqual(alphabet.x + 1);
			expect(alphabet.x + alphabet.width).toBeLessThanOrEqual(320);
		}
		await button(page, 'Back to Library').tap();
	}
});

test('grid drill-down and Back retain the row, keyboard focus, layout and active filters', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const s = await connect(page, 600);
	await button(page, 'Browse Albums').click();
	const shelf = index(page),
		main = page.locator('main');
	await button(page, 'Collection options').click();
	await chooseOption(page.getByLabel('Grid columns'), '3');
	await button(page, 'Search albums').click();
	await page.getByRole('searchbox').fill('Album');
	await expect.poll(() => s.requests.some((u) => u.searchParams.get('q') === 'Album')).toBe(true);
	await expect(shelf).toHaveAttribute('data-loaded', '30');
	for (let i = 30; i < 210; i += 30) await step(page, i);
	await shelf.evaluate((n) => {
		const main = n.closest('main')!,
			pitch =
				(n.clientHeight + parseFloat(getComputedStyle(n).rowGap)) /
				Math.ceil(Number(n.dataset.loaded) / 3);
		main.scrollTop += n.getBoundingClientRect().top - main.getBoundingClientRect().top + 54 * pitch;
	});
	const visible = shelf.locator('[data-browse-index="170"] button.item');
	await expect(visible).toBeInViewport();
	const width = (await visible.boundingBox())!.width;
	expect(width).toBeGreaterThan(80);
	expect(width).toBeLessThan(132);
	await visible.scrollIntoViewIfNeeded();
	const before = await main.evaluate((m) => m.scrollTop);
	await visible.click();
	await expect(page.getByRole('heading', { name: 'Album 00170', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(visible).toBeFocused();
	expect(Math.abs((await main.evaluate((m) => m.scrollTop)) - before)).toBeLessThan(5);
	await expect(shelf).toHaveAttribute('data-columns', '3');
	await expect(page.getByRole('searchbox')).toHaveValue('Album');
	await page.keyboard.press('Tab');
	await expect(shelf.locator('[data-browse-index="171"] button.item')).toBeFocused();
	const errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	await page.keyboard.press('Escape');
	await expect(button(page, 'Browse Albums')).toBeVisible();
	expect(errors).toEqual([]);
});

test('a hidden collection cancels its pending page and resumes only after a scroll or More', async ({
	page
}) => {
	const s = await connect(page, 120);
	await button(page, 'Browse Albums').click();
	const shelf = index(page);
	await expect(shelf).toHaveAttribute('data-loaded', '30');
	const hold = s.holdNext();
	await page.locator('main').hover();
	await page.mouse.wheel(0, 250000);
	await hold.arrival;
	await page.mouse.wheel(0, 200);
	await button(page, 'Album 00027').click();
	await expect(page.getByRole('heading', { name: 'Album 00027', exact: true })).toBeVisible();
	hold.release();
	await page.keyboard.press('Escape');
	await expect(button(page, 'Album 00027')).toBeFocused();
	await expect(shelf).toHaveAttribute('data-loaded', '30');
	expect(s.requests.filter((u) => u.searchParams.has('after'))).toHaveLength(1);
	await button(page, 'More albums').click();
	await expect(shelf).toHaveAttribute('data-loaded', '60');
});

test('a playlist page is read once and returns to the same tile after opening its entries', async ({
	page
}) => {
	await connect(page);
	let reads = 0;
	const list = Array.from({ length: 128 }, (_, i) => ({
		id: 'p' + i,
		name: 'Playlist ' + label(i),
		is_owner: true,
		is_public: false,
		can_edit: true,
		can_delete: true,
		is_redacted: false,
		track_count: 0,
		cover_urls: []
	}));
	await page.route(server + '/api/v3/playlists', (route) => {
		reads++;
		return route.fulfill({ json: { playlists: list } });
	});
	await page.route(server + '/api/v3/playlists/p*', (route) =>
		route.fulfill({
			json: {
				...list.find((p) =>
					route
						.request()
						.url()
						.endsWith('/' + p.id)
				),
				tracks: []
			}
		})
	);
	await button(page, 'Browse Playlists').click();
	const shelf = index(page),
		main = page.locator('main');
	await expect(shelf).toHaveAttribute('data-loaded', '48');
	await step(page, 48);
	expect(reads).toBe(1);
	await shelf.evaluate((n) => {
		const main = n.closest('main')!,
			pitch =
				(n.clientHeight + parseFloat(getComputedStyle(n).rowGap)) /
				Math.ceil(Number(n.dataset.loaded) / 2);
		main.scrollTop += n.getBoundingClientRect().top - main.getBoundingClientRect().top + 32 * pitch;
	});
	const tile = button(page, 'Playlist 00066');
	await expect(tile).toBeInViewport();
	const offset = await main.evaluate((m) => m.scrollTop);
	await tile.click();
	await expect(page.getByRole('heading', { name: 'Playlist 00066', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(tile).toBeFocused();
	await expect(shelf).toHaveAttribute('data-loaded', '96');
	expect(reads).toBe(1);
	expect(Math.abs((await main.evaluate((m) => m.scrollTop)) - offset)).toBeLessThan(5);
});

test('six-column virtual track grids retain 44px controls, row spacing and keyboard order', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await connect(page, 600);
	// Exercise the largest outer spacing supported by the theme editor at this phone width.
	await page.evaluate(() => document.documentElement.style.setProperty('--gap', '24px'));
	await button(page, 'Browse Tracks').click();
	const shelf = index(page);
	await button(page, 'Collection options').click();
	await chooseOption(page.getByRole('combobox', { name: 'Display', exact: true }), 'grid');
	await chooseOption(page.getByLabel('Grid columns'), '6');
	await page.getByLabel('Compact rows').check();
	await button(page, 'Collection options').click();
	for (let n = 30; n < 300; n += 30) await step(page, n);
	await expect(shelf).toHaveClass(/windowed/);
	expect(await shelf.getByRole('listitem').count()).toBeLessThan(240);
	await shelf.evaluate((el) => {
		const main = el.closest('main')!,
			pitch =
				(el.clientHeight + parseFloat(getComputedStyle(el).rowGap)) /
				Math.ceil(Number(el.dataset.loaded) / 6);
		main.scrollTop +=
			el.getBoundingClientRect().top - main.getBoundingClientRect().top + 18 * pitch;
	});
	const at = (n: number) => shelf.locator('[data-browse-index="' + n + '"]');
	await expect(at(120).locator('.item')).toBeInViewport();
	const layout = await shelf.evaluate((el) => {
		const box = (i: number) =>
			el.querySelector('[data-browse-index="' + i + '"]')!.getBoundingClientRect();
		const first = box(120),
			last = box(125),
			next = box(126),
			bounds = el.getBoundingClientRect();
		return {
			first: first.left - bounds.left,
			last: bounds.right - last.right,
			sameLine: Math.abs(last.top - first.top),
			width: first.width,
			spacing: next.top - first.bottom,
			gap: parseFloat(getComputedStyle(el).rowGap),
			adjacentGap: box(121).left - first.right,
			cssGap: parseFloat(getComputedStyle(el).columnGap)
		};
	});
	expect(layout.width).toBeGreaterThanOrEqual(44);
	expect(layout.first).toBeCloseTo(0, 0);
	expect(layout.last).toBeCloseTo(0, 0);
	expect(layout.sameLine).toBeLessThan(1);
	expect(layout.adjacentGap).toBeCloseTo(layout.cssGap, 0);
	expect(layout.spacing).toBeCloseTo(layout.gap, 0);
	const item = at(120).locator('button.item');
	await item.press('Shift+Space');
	await expect(item).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Tab');
	await expect(at(120).getByRole('button', { name: /More options/ })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(at(121).locator('button.item')).toBeFocused();
	await page.screenshot({ path: test.info().outputPath('library-six-column-selection-320.png') });
});

test('a held finger adds or removes a reversible range and Cancel exits selection mode', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 820 });
	const { streams } = await connect(page);
	await button(page, 'Browse Tracks').tap();
	const list = index(page);
	const item = (i: number) => list.locator('[data-browse-index="' + i + '"] button.item');
	const count = (n: number) => page.getByText(n + ' selected', { exact: true });
	const touch = await touchRange(page);
	const hold = (i: number) => touch.hold(item(i));
	const move = (i: number) => touch.move(item(i));
	await expect(item(3)).toBeVisible();

	await hold(3);
	await expect(count(1)).toBeVisible();
	await expect(item(3)).toHaveAttribute('aria-pressed', 'true');
	await move(7);
	await expect(count(5)).toBeVisible();
	await move(5);
	await expect(count(3)).toBeVisible();
	await touch.lift();
	await expect(item(3)).toHaveAttribute('aria-pressed', 'true');
	await expect(item(6)).toHaveAttribute('aria-pressed', 'false');
	await item(0).tap();
	await expect(count(4)).toBeVisible();
	await hold(4); // Starting on an existing selection makes this a removal gesture.
	await expect(count(3)).toBeVisible();
	await move(3);
	await expect(count(2)).toBeVisible();
	await move(4);
	await expect(count(3)).toBeVisible();
	await touch.lift();
	await expect(item(0)).toHaveAttribute('aria-pressed', 'true');
	await expect(item(3)).toHaveAttribute('aria-pressed', 'true');
	await expect(item(4)).toHaveAttribute('aria-pressed', 'false');
	await button(page, 'Cancel selection').tap();
	await expect(button(page, 'Select items')).toHaveCount(0);
	await expect(page.getByRole('group', { name: 'Selection actions' })).toHaveCount(0);
	// An ordinary flick before the hold threshold scrolls without entering selection.
	const start = await touch.point(item(3));
	await hold(3);
	await touch.moveTo(start.x, start.y - 90);
	await touch.lift();
	await expect(page.getByRole('group', { name: 'Selection actions' })).toHaveCount(0);
	await page.locator('main').evaluate((m) => m.scrollTo(0, 0));
	expect(streams).toEqual([]);
	await touch.close();
});

test('holding a range at the scroll edge continues through cursor pages and virtual rows', async ({
	page
}) => {
	await page.setViewportSize({ width: 390, height: 740 });
	const { streams } = await connect(page, 240);
	await button(page, 'Browse Tracks').tap();
	const list = index(page),
		first = list.locator('[data-browse-index="1"] .item');
	await expect(first).toBeVisible();
	const touch = await touchRange(page);
	const anchor = await touch.point(first),
		bounds = (await page.locator('main').boundingBox())!;
	await touch.hold(first);
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await touch.moveTo(anchor.x, Math.floor(bounds.y + bounds.height - 3));
	const speedRatio = await page.locator('main').evaluate(async (main) => {
		const sample = () => ({ top: main.scrollTop, time: performance.now() });
		const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
		const a = sample();
		await wait(350);
		const b = sample();
		await wait(1100);
		const c = sample();
		await wait(350);
		const d = sample();
		const speed = (from: typeof a, to: typeof a) => (to.top - from.top) / (to.time - from.time);
		return speed(c, d) / speed(a, b);
	});
	expect(speedRatio).toBeGreaterThan(1.4);
	const selection = page.getByRole('group', { name: 'Selection actions' }).locator('strong');
	await expect
		.poll(async () => parseInt((await selection.textContent()) || '0'), { timeout: 18000 })
		.toBeGreaterThan(72);
	await touch.moveTo(anchor.x, Math.floor(bounds.y + 8));
	await expect.poll(async () => parseInt((await selection.textContent()) || '0')).toBeLessThan(64);
	await touch.lift();
	const count = await selection.textContent();
	expect(Number(await list.getAttribute('data-loaded'))).toBeGreaterThan(72);
	await expect(first).toHaveCount(0);
	expect(await list.getByRole('listitem').count()).toBeLessThan(60);
	await expect(selection).toHaveText(count!);
	await button(page, 'Cancel selection').click();
	expect(streams).toEqual([]);
	await touch.close();
});

test('a range in the album grid follows collection order across columns', async ({ page }) => {
	await connect(page);
	await button(page, 'Browse Albums').tap();
	const grid = index(page);
	await expect(grid).toHaveAttribute('data-columns', '2');
	const touch = await touchRange(page);
	const item = (i: number) => grid.locator('[data-browse-index="' + i + '"] .item');
	await touch.hold(item(0));
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await touch.move(item(3));
	await expect(page.getByText('4 selected', { exact: true })).toBeVisible();
	await touch.move(item(1));
	await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
	await touch.lift();
	await expect(grid.locator('[data-browse-index="2"] .item')).toHaveAttribute(
		'aria-pressed',
		'false'
	);
	await touch.close();
});
