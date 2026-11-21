import { chooseOption, choiceList } from './fixtures/inlineChoice';
import { test, expect, type Page } from '@playwright/test';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';
import { seedOfflineMusic } from './fixtures/offlineMusic';
test('Library opens its five categories, shows a true count and switches between the artist grid and list', async ({
	page
}) => {
	const server = 'https://library-categories.example';
	await page.route(server + '/api/v3/**', async (route) => {
		const p = new URL(route.request().url()).pathname.slice(7);
		const send = (json: unknown) => route.fulfill({ json });
		if (p === '/auth/providers') return send({ local: true, oidc: false });
		if (p === '/auth/login') return send({ token: 'fixture' });
		if (p === '/me') return send({ id: 'member', display_name: 'Listener', role: 'user' });
		if (p === '/library/artists')
			return send({
				items: [{ id: 'a', name: 'North Shore', album_count: 2 }],
				total: 143,
				next: 'cursor'
			});
		if (p.includes('/artwork')) return route.fulfill({ status: 404 });
		if (await emptyBoardRead(route)) return;
		throw Error(p);
	});
	await page.goto('/');
	const b = (name: string) => page.getByRole('button', { name, exact: true });
	await page.getByLabel('Server address').fill(server);
	await b('Continue').click();
	await page.getByLabel('Username', { exact: true }).fill('member');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await b('Sign in').click();
	await b('Library').click();
	const index = page.getByRole('navigation', { name: 'Library categories' });
	await expect(index.getByRole('button')).toHaveText([
		'Playlists',
		'Artists',
		'Albums',
		'Tracks',
		'Genres'
	]);
	await page.screenshot({ path: test.info().outputPath('library-index.png') });
	await b('Browse Artists').click();
	const banner = page.getByRole('banner');
	await expect(banner.getByRole('heading', { name: 'Artists', exact: true })).toBeVisible();
	await expect(banner.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
	await expect(b('North Shore')).toBeVisible();
	await page.screenshot({ path: test.info().outputPath('library-artists.png') });
	await b('Collection filters').click();
	await b('Favorites only').click();
	await b('Settings').click();
	await b('Back').click();
	await expect(b('Favorites only')).toHaveAttribute('aria-pressed', 'true');
	await expect(banner.getByRole('heading', { name: 'Artists', exact: true })).toBeVisible();
	const items = page.locator('[data-part=category-items]');
	await expect(items).toHaveAttribute('data-columns', '3');
	await expect(page.getByText('143 items')).toBeVisible();
	await expect(items.getByRole('button', { name: 'North Shore', exact: true })).toBeVisible();
	await b('Switch to list view').click();
	await expect(items).toHaveAttribute('data-layout', 'list');
	await items.getByRole('button', { name: 'North Shore', exact: true }).press('Shift+Space');
	await expect(page.getByText('1 selected')).toBeVisible();
	await b('Cancel selection').click();
	await b('Back to Library').click();
	await expect(b('Library sections')).toBeVisible();
});

const fixtureServer = 'https://library-display.example';
const records = [
	{
		id: 'second',
		title: 'Night Passage',
		genre: 'Jazz',
		year: 2020,
		disc_number: 1,
		track_number: 2
	},
	{ id: 'first', title: 'Arrival', genre: 'jazz', year: 2020, disc_number: 1, track_number: 1 },
	{ id: 'third', title: 'Final Light', genre: '', year: 2024, disc_number: 2, track_number: 1 }
].map((t) => ({
	...t,
	artist_name: 'North Shore',
	album_title: 'Evening Shore',
	album_id: 'evening',
	artist_id: 'north',
	format: 'flac',
	art_missing: true,
	favorite: false
}));
const album = {
	id: 'evening',
	title: 'Evening Shore',
	artist_name: 'North Shore',
	year: 2020,
	art_missing: true
};
const playlist = {
	id: 'evening-set',
	name: 'In rotation',
	is_owner: true,
	can_edit: true,
	can_delete: true,
	is_redacted: false,
	track_count: 2,
	cover_urls: ['/api/v3/library/albums/a/artwork', '/api/v3/library/albums/b/artwork']
};
const pct = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function displayFixture(page: Page) {
	const walks: string[] = [],
		blocked: string[] = [];
	let local = false;
	await page.route(fixtureServer + '/api/v3/**', async (route) => {
		const url = new URL(route.request().url()),
			p = url.pathname.slice(7),
			send = (json: unknown) => route.fulfill({ json });
		if (local) {
			blocked.push(p);
			return route.abort();
		}
		if (p === '/auth/providers') return send({ local: true, oidc: false });
		if (p === '/auth/login') return send({ token: 'fixture' });
		if (p === '/me') return send({ id: 'member', display_name: 'Listener', role: 'user' });
		if (p === '/me/section-prefs') return send({ pages: { home: [] } });
		if (p === '/home') return send({ sections: [], refreshing: false });
		if (p === '/library/stats') return send({ total_tracks: 3, last_scan_at: 100 });
		if (p === '/ratings/lookup' && route.request().method() === 'POST') {
			const { track_ids } = route.request().postDataJSON();
			expect(track_ids.every((id: string) => records.some((track) => track.id === id))).toBe(true);
			return send({ tracks: {}, albums: {}, artists: {} });
		}
		if (p === '/library/albums') return send({ items: [album], total: 1, next: null });
		if (p === '/library/artists')
			return send({
				items: [{ id: 'north', name: 'North Shore', album_count: 1 }],
				next: null,
				total: 1
			});
		if (p === '/library/tracks') {
			const params = url.searchParams;
			if (params.has('genre')) {
				const group = records.filter(
					(r) => r.genre.toLowerCase() === params.get('genre')!.toLowerCase()
				);
				return send({ items: group, total: group.length, next: null });
			}
			if (params.get('limit') === '500') {
				walks.push(params.get('after') ?? 'start');
				return send(
					params.has('after')
						? { items: records.slice(2), next: null, total: 3 }
						: { items: records.slice(0, 2), next: 'tag-page', total: 3 }
				);
			}
			return send({ items: records, total: 3, next: null });
		}
		if (p === '/playlists')
			return send({
				playlists: [
					playlist,
					{ ...playlist, id: 'unused', name: 'No available songs', cover_urls: [], track_count: 0 }
				]
			});
		if (p === '/playlists/evening-set')
			return send({
				...playlist,
				tracks: [...records.slice(0, 2), records[0]].map((t, i) => ({
					id: 'e' + i,
					track_name: t.title,
					artist_name: t.artist_name,
					album_name: t.album_title,
					source_type: 'local',
					library_file_id: t.id,
					track_source_id: t.id
				}))
			});
		if (p.includes('/artwork')) return route.fulfill({ status: 404 });
		if (await emptyBoardRead(route)) return;
		throw Error(p);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(fixtureServer);
	await pct(page, 'Continue').click();
	await page.getByLabel('Username', { exact: true }).fill('member');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await pct(page, 'Sign in').click();
	await pct(page, 'Library').click();
	return { walks, blocked, preventNetwork: () => (local = true) };
}
test('album display follows the listener into an artist’s releases, release filters and guest appearances', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await displayFixture(page);
	const releases = Array.from({ length: 8 }, (_, i) => ({
		...album,
		id: 'record-' + i,
		title: 'Record ' + (i + 1)
	}));
	for (const path of ['albums', 'appearances'])
		await page.route(fixtureServer + '/api/v3/library/artists/north/' + path + '?**', (route) =>
			route.fulfill({ json: { items: releases, total: releases.length, next: null } })
		);
	const b = (name: string) => pct(page, name);
	await b('Browse Albums').tap();
	await b('Collection options').tap();
	const results = page.locator('[data-part=category-items]:visible');
	for (const columns of [1, 2, 3, 4, 5, 6]) {
		await chooseOption(page.getByLabel('Grid columns'), String(columns));
		expect(
			await results.evaluate((list) => getComputedStyle(list).gridTemplateColumns.split(' ').length)
		).toBe(columns);
	}
	await chooseOption(page.getByLabel('Grid columns'), '5');
	await page.getByRole('checkbox', { name: 'Compact rows' }).check();
	const compactGap = await results.evaluate((list) => getComputedStyle(list).rowGap);
	await b('Back to Library').tap();
	await b('Browse Artists').tap();
	await b('North Shore').tap();
	const gallery = page.locator('[data-part=local-artist-detail] [data-part=album-grid]');
	const verifyGrid = async () => {
		await expect(gallery.getByRole('button')).toHaveCount(8);
		await expect(gallery).toHaveCSS('row-gap', compactGap);
		const cards = await gallery.getByRole('button').evaluateAll((buttons) =>
			buttons.map((button) => {
				const { x, top, width } = button.getBoundingClientRect();
				return { x, top, width };
			})
		);
		expect(new Set(cards.map((r) => r.x)).size).toBe(5);
		expect(cards[0].width).toBeGreaterThanOrEqual(44);
		expect(cards[4].top).toBe(cards[0].top);
		expect(cards[5].top).toBeGreaterThan(cards[0].top);
	};
	await verifyGrid();
	await chooseOption(page.getByRole('combobox', { name: 'Release type' }), 'unknown');
	await verifyGrid();
	await chooseOption(page.getByLabel('Artist library view'), 'appearances');
	await verifyGrid();
	await b('Back to artists').tap();
	await b('Back to Library').tap();
	await b('Browse Albums').tap();
	await b('Switch to list view').tap();
	await b('Back to Library').tap();
	await b('Browse Artists').tap();
	await b('North Shore').tap();
	await expect(gallery).toHaveAttribute('data-layout', 'list');
	await expect(gallery.getByRole('button')).toHaveCount(8);
	const cover = gallery.getByRole('button').first().locator('[data-part=cover]');
	expect((await cover.boundingBox())!.width).toBeLessThan(60);
});

test('Library layout settings update the open collection, preserve its sorting and discard canceled display changes', async ({
	page
}) => {
	await displayFixture(page);
	const b = (name: string) => pct(page, name);
	const result = page.locator('[data-part=category-items]:visible');
	await b('Browse Albums').tap();
	await b('Reverse sort order').tap();
	const edit = async () => {
		await b('Settings').tap();
		await b('Library layout').tap();
		const details = page
			.locator('details')
			.filter({ has: page.getByText('Library pages', { exact: true }) });
		await details.locator('summary').tap();
		await chooseOption(details.getByLabel('Library page'), 'Albums');
		return details;
	};
	let details = await edit();
	await chooseOption(details.getByLabel('Grid columns'), '4');
	await details.getByRole('checkbox', { name: 'Compact rows' }).check();
	await b('Cancel').tap();
	await b('Back').tap();
	await expect(result).toHaveAttribute('data-columns', '2');
	details = await edit();
	await chooseOption(details.getByLabel('Grid columns'), '4');
	await details.getByRole('checkbox', { name: 'Compact rows' }).check();
	await chooseOption(details.getByLabel('Library page'), 'Artists');
	await chooseOption(details.getByLabel('Grid columns'), '1');
	await page.evaluate(() => {
		const write = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key.startsWith('dn.mobile.boards.v2.')) {
				Storage.prototype.setItem = write;
				throw new DOMException('Device storage full', 'QuotaExceededError');
			}
			write.call(this, key, value);
		};
	});
	await b('Save layout').tap();
	await expect(page.getByRole('alert')).toContainText('Could not save this layout');
	expect(
		await page.evaluate((server) => {
			const prefix = 'dn.mobile.library-browse.v1.';
			const record = (name: string) =>
				localStorage.getItem(prefix + JSON.stringify([server, 'member', name]));
			return { columns: JSON.parse(record('Albums')!).columns, artists: record('Artists') };
		}, fixtureServer)
	).toEqual({ columns: 2, artists: null });
	await b('Save layout').tap();
	await b('Back').tap();
	await expect(result).toHaveAttribute('data-columns', '4');
	await b('Collection options').tap();
	await expect(page.getByLabel('Grid columns')).toHaveAttribute('data-value', '4');
	await expect(page.getByRole('checkbox', { name: 'Compact rows' })).toBeChecked();
	await b('Back to Library').tap();
	await b('Browse Artists').tap();
	await expect(result).toHaveAttribute('data-columns', '1');
	await b('Back to Library').tap();
	const request = page.waitForRequest(
		(r) => new URL(r.url()).pathname === '/api/v3/library/albums'
	);
	await b('Browse Albums').tap();
	expect(new URL((await request).url()).searchParams.get('order')).toBe('desc');
});

test('catalog pages use themed controls, distinct layouts, real genre tracks and working playlist actions', async ({
	page
}, testInfo) => {
	const { walks } = await displayFixture(page),
		b = (n: string) => pct(page, n),
		tiles = page.locator('[data-part=category-items]:visible');
	await b('Browse Albums').click();
	await expect(b('Evening Shore')).toBeVisible();
	await expect(tiles).toHaveAttribute('data-columns', '2');
	await page.screenshot({ path: testInfo.outputPath('library-albums.png') });
	const geometry = await b('Evening Shore').locator('.art').boundingBox();
	expect(geometry!.height).toBeCloseTo(geometry!.width, 0);
	await b('Collection options').click();
	await chooseOption(page.getByLabel('Grid columns'), '3');
	await expect(tiles).toHaveAttribute('data-columns', '3');
	await b('Back to Library').click();
	await b('Browse Albums').click();
	await expect(tiles).toHaveAttribute('data-columns', '3');
	await b('Back to Library').click();
	await b('Browse Tracks').click();
	await expect(tiles).toHaveAttribute('data-layout', 'list');
	await expect(b('Play Arrival')).toContainText('North Shore · 2020');
	await page.screenshot({ path: testInfo.outputPath('library-tracks.png') });
	const art = await b('Play Arrival').locator('.art').boundingBox();
	expect(art!.width).toBeLessThan(60);
	await b('More options for Arrival').click();
	await expect(
		page.getByRole('dialog').getByRole('button', { name: 'Add to queue' })
	).toBeVisible();
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
	await b('Back to Library').click();
	expect(walks).toEqual([]);
	await b('Browse Genres').click();
	await expect(b('Jazz')).toBeVisible();
	await expect(b('Missing genre')).toBeVisible();
	await expect(page.getByText('2 items')).toBeVisible();
	expect(walks).toEqual(['start', 'tag-page']);
	await page.screenshot({ path: testInfo.outputPath('library-genres.png') });
	await b('More options for Jazz').click();
	await page.getByRole('dialog').getByRole('button', { name: 'Open genre' }).click();
	await expect(page.getByRole('heading', { name: 'Jazz' })).toBeVisible();
	await expect(b('Play Arrival')).toBeVisible();
	await expect(b('Play Final Light')).toHaveCount(0);
	await b('Back to Genres').click();
	await b('Back to Library').click();
	await b('Browse Playlists').click();
	await expect(tiles).toHaveAttribute('data-columns', '2');
	await expect(b('In rotation').locator('.collage [data-part=cover]')).toHaveCount(4);
	await expect(b('No available songs').locator('.art svg')).toHaveCount(1);
	await expect(b('Import playlist')).toBeVisible();
	await expect(b('New playlist')).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath('library-playlists.png') });
	await page.setViewportSize({ width: 320, height: 680 });
	await b('Back to Library').click();
	await b('Browse Albums').click();
	await expect(b('Evening Shore')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
	for (const action of [
		'Play all',
		'Shuffle all',
		'Play next',
		'Add to queue',
		'Collection filters'
	]) {
		const rect = await b(action).boundingBox();
		expect(rect!.width).toBeGreaterThanOrEqual(44);
	}
	await page.screenshot({ path: testInfo.outputPath('library-albums-320.png') });
});

test('offline categories retain their groups, playlist membership and classified availability without contacting DN', async ({
	page,
	context
}) => {
	const f = await displayFixture(page),
		b = (n: string) => pct(page, n),
		scope = JSON.stringify([fixtureServer, 'member']);
	await b('Browse Playlists').click();
	await b('In rotation').click();
	await expect(page.getByText('Arrival', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await b('Back to Library').click();
	await b('Browse Tracks').click();
	await expect(b('Play Arrival')).toBeVisible();
	// A returning listener can have all three origins from prior manual saves, rules and playback.
	await page.evaluate(
		async ({ scope, records }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const r = indexedDB.open('dn.mobile.offline.v1', 1);
				r.onsuccess = () => resolve(r.result);
				r.onerror = () => reject(r.error);
			});
			const tx = db.transaction('tracks', 'readwrite'),
				s = tx.objectStore('tracks');
			for (const [i, t] of records.entries()) {
				const audio = new Blob(['test track ' + i], { type: 'audio/wav' });
				const track = {
					id: t.id,
					title: t.title,
					artist: t.artist_name,
					artistId: t.artist_id,
					album: t.album_title,
					albumId: t.album_id,
					genre: t.genre,
					year: t.year,
					discNumber: t.disc_number,
					trackNumber: t.track_number,
					format: t.format,
					streamUrl: '/api/v3/stream/local/' + t.id
				};
				s.put({
					scope,
					id: track.id,
					track,
					origin: ['downloaded', 'automatic', 'cached'][i],
					pinned: i === 0,
					used: 1 + i,
					bytes: audio.size,
					audio
				});
			}
			await new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
			window.dispatchEvent(new Event('dn-offline-media'));
		},
		{ scope, records }
	);
	await expect(page.getByRole('group', { name: 'Offline availability' })).toContainText(
		'Available offline'
	);
	await context.setOffline(true);
	f.preventNetwork();
	await b('Back to Library').click();
	await b('Browse Albums').click();
	const legend = page.getByRole('group', { name: 'Offline availability' });
	await expect(legend).toHaveText('Available offline');
	await b('Evening Shore').click();
	const names = page.locator('[data-part=category-items]:visible button.item strong');
	await expect(names).toHaveText(['Arrival', 'Night Passage', 'Final Light']);
	await b('Back to Albums').click();
	await b('Collection filters').click();
	await chooseOption(page.getByLabel('Availability', { exact: true }), 'offline');
	await expect(legend).toHaveText('Available offline');
	await b('Back to Library').click();
	const availability = page.getByLabel('Availability', { exact: true });
	await expect(availability).toHaveAttribute('data-value', 'offline');

	await b('Library').click();
	await expect(availability).toHaveAttribute('data-value', 'offline');
	await b('Browse Tracks').click();
	await expect(names).toHaveCount(3);
	await b('Back to Library').click();

	await b('Browse Playlists').click();
	await expect(b('In rotation')).toBeVisible();
	await expect(b('No available songs')).toHaveCount(0);
	await page.setViewportSize({ width: 320, height: 680 });
	const filters = b('Collection filters');
	await expect(filters).toBeInViewport();
	await filters.click();
	await expect(availability).toHaveAttribute('data-value', 'offline');
	await availability.click();
	await expect(page.getByRole('option')).toHaveCount(2);
	await page.keyboard.press('Escape');
	await expect(b('In rotation')).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
	await chooseOption(page.getByLabel('Availability', { exact: true }), 'all');
	await expect(page.getByRole('group', { name: 'Offline availability' })).toContainText(
		'Available offline'
	);

	await b('In rotation').click();
	await expect(names).toHaveText(['Night Passage', 'Arrival', 'Night Passage']);
	await b('Back to Playlists').click();
	await b('Back to Library').click();
	await b('Browse Genres').click();
	await expect(b('Jazz')).toBeVisible();
	await expect(b('Missing genre')).toBeVisible();
	expect(f.blocked).toEqual([]);
});

test('a 76k-track genre index resumes its cursor, survives restart and invalidates on a DN scan', async ({
	page
}) => {
	test.setTimeout(80000);
	await displayFixture(page);
	const total = 76_014,
		cursors: number[] = [],
		b = (n: string) => pct(page, n);
	let changed = false,
		hold = true,
		release: () => void = () => {};
	await page.route(fixtureServer + '/api/v3/library/stats', (route) =>
		route.fulfill({
			json: { last_scan_at: changed ? 222 : 111, total_tracks: changed ? 1 : total }
		})
	);
	await page.route(fixtureServer + '/api/v3/library/tracks?**', async (route) => {
		const p = new URL(route.request().url()).searchParams;
		expect(p.get('limit')).toBe('500');
		const offset = Number(p.get('after') || 0);
		cursors.push(offset);
		if (hold && offset === 500) {
			await new Promise<void>((resolve) => (release = resolve));
			return route.abort().catch(() => {});
		}
		const count = changed ? 1 : total,
			end = Math.min(offset + 500, count);
		const items = Array.from({ length: end - offset }, (_, i) => ({
			id: 'file-' + (offset + i),
			genre: changed ? 'Ambient' : (offset + i) % 8 === 0 ? 'Jazz' : 'Soul'
		}));
		return route.fulfill({ json: { items, next: end < count ? String(end) : null, total: count } });
	});
	await b('Browse Genres').click();
	await expect(page.getByRole('status')).toHaveText('Reading genre tags · 500 of 76,014');
	await b('Back to Library').click();
	hold = false;
	release();
	await b('Browse Genres').click();
	await expect(b('Soul')).toBeVisible({ timeout: 45000 });
	await expect(b('Jazz')).toBeVisible();
	expect(cursors.filter((x) => x === 0)).toHaveLength(1);
	expect(cursors.at(-1)).toBe(76000);
	const reads = cursors.length;
	await localSignIn(page, fixtureServer, 'member');
	await b('Library').click();
	await b('Browse Genres').click();
	await expect(b('Jazz')).toBeVisible();
	expect(cursors).toHaveLength(reads);
	changed = true;
	await localSignIn(page, fixtureServer, 'member');
	await b('Library').click();
	await b('Browse Genres').click();
	await expect(b('Ambient')).toBeVisible();
	await expect(b('Jazz')).toHaveCount(0);
	expect(cursors.length).toBe(reads + 1);
});

test('all five categories keep their own one-to-six-column grid and compact spacing on a narrow phone', async ({
	page
}) => {
	test.setTimeout(60000);
	await page.setViewportSize({ width: 320, height: 720 });
	await displayFixture(page);
	await seedOfflineMusic(
		page,
		fixtureServer,
		'member',
		false,
		records.map((song, i) => ({
			track: {
				id: song.id,
				title: song.title,
				album: song.album_title,
				albumId: song.album_id,
				artist: song.artist_name,
				artistId: song.artist_id,
				genre: song.genre,
				streamUrl: '/api/v3/stream/local/' + song.id
			},
			origin: (['downloaded', 'automatic', 'cached'] as const)[i]
		}))
	);
	const b = (name: string) => pct(page, name),
		results = page.locator('[data-part=category-items]:visible');
	const display = page.getByRole('combobox', { name: 'Display', exact: true });
	const columns = page.getByLabel('Grid columns');
	const compact = page.getByRole('checkbox', { name: 'Compact rows' });
	const sizes = () =>
		results.evaluate((el) => {
			const css = getComputedStyle(el),
				item = el.querySelector<HTMLElement>('button.item')!;
			return {
				columns: css.gridTemplateColumns.split(' ').length,
				full: el.clientWidth,
				cell: item.getBoundingClientRect().width,
				rowGap: parseFloat(css.rowGap),
				metaPadding: parseFloat(getComputedStyle(item.querySelector('.meta')!).paddingTop)
			};
		});
	for (const category of ['Artists', 'Albums', 'Tracks', 'Genres', 'Playlists']) {
		await b('Browse ' + category).tap();
		await expect(results.locator('.item').first()).toBeVisible();
		await b('Collection options').tap();
		if (category === 'Tracks') {
			await expect(display).toHaveAttribute('data-value', 'list');
			const row = results.locator('.item').first();
			const listHeight = (await row.boundingBox())!.height;
			const gap = await results.evaluate((e) => parseFloat(getComputedStyle(e).rowGap));
			await compact.check();
			const compactHeight = (await row.boundingBox())!.height;
			expect(compactHeight).toBeGreaterThanOrEqual(44);
			expect(compactHeight).toBeLessThan(listHeight);
			expect(await results.evaluate((e) => parseFloat(getComputedStyle(e).rowGap))).toBeLessThan(
				gap
			);
			await compact.uncheck();
		}
		await chooseOption(display, 'grid');
		await expect((await choiceList(columns)).getByRole('option')).toHaveText([
			'1',
			'2',
			'3',
			'4',
			'5',
			'6'
		]);
		await chooseOption(columns, '1');
		const single = await sizes();
		expect(single.columns).toBe(1);
		expect(single.cell).toBeCloseTo(single.full, 0);
		await chooseOption(columns, '6');
		const regular = await sizes();
		expect(regular.columns).toBe(6);
		expect(regular.cell).toBeGreaterThanOrEqual(44);
		expect(regular.cell).toBeLessThan(50);
		await compact.check();
		const dense = await sizes();
		expect(dense.rowGap).toBeLessThan(regular.rowGap);
		expect(dense.metaPadding).toBeLessThan(regular.metaPadding);
		const cell = results.locator('.entry').first();
		const primary = cell.locator('.item');
		await primary.scrollIntoViewIfNeeded();
		const menu = cell.getByRole('button', { name: /^More options/ });
		if (['Tracks', 'Genres', 'Playlists'].includes(category)) {
			const box = (await primary.boundingBox())!,
				dots = (await menu.boundingBox())!;
			expect(dots.width).toBeGreaterThanOrEqual(44);
			expect(dots.height).toBeGreaterThanOrEqual(44);
			expect(dots.y).toBeGreaterThanOrEqual(box.y + box.height - 0.5);
			await menu.tap();
			await expect(page.getByRole('dialog')).toBeVisible();
			await page.keyboard.press('Escape');
		}
		if (category === 'Albums' || category === 'Artists') {
			const badge = primary.locator('.offline');
			await expect(primary).toHaveAccessibleDescription('Available offline');
			await expect(badge).toHaveAttribute('aria-label', 'Available offline');
			expect(
				await badge.evaluate((el) => {
					const cover = el.closest('.visual')!.getBoundingClientRect(),
						badge = el.getBoundingClientRect();
					const marks = [...el.querySelectorAll('svg')].map((svg) => svg.getBoundingClientRect());
					return (
						marks.length === 1 &&
						marks.every(
							(mark) => mark.width >= 10 && mark.left >= cover.left && mark.right <= cover.right
						) &&
						badge.top >= cover.top &&
						badge.bottom <= cover.bottom
					);
				})
			).toBe(true);
		}
		if (category === 'Tracks') {
			await primary.press('Shift+Space');
			await expect(primary).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByText('1 selected')).toBeVisible();
			await b('Cancel selection').tap();
		}
		if (category === 'Artists') await chooseOption(columns, '1');
		await b('Back to Library').tap();
	}
	for (const [category, n] of [
		['Artists', '1'],
		['Albums', '6']
	]) {
		await b('Browse ' + category).tap();
		await expect(results).toHaveAttribute('data-columns', n);
		await b('Collection options').tap();
		await expect(compact).toBeChecked();
		await b('Back to Library').tap();
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});
