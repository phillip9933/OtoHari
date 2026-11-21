import { minimizePlayer } from './fixtures/minimizePlayer';
import { chooseOption } from './fixtures/inlineChoice';
import { test, expect, type Page } from '@playwright/test';
import { seedOfflineMusic } from './fixtures/offlineMusic';
import { localSignIn } from './fixtures/localSignIn';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
const server = 'https://device-search.example';
const otherServer = 'https://another-search.example';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const scope = (page: Page, name: string) =>
	page.getByRole('group', { name: 'Search category' }).getByRole('button', { name, exact: true });
const box = (page: Page) => page.getByRole('searchbox', { name: 'Search music' });
const normalList = {
	id: 'night',
	name: 'Ámber radio',
	is_owner: true,
	can_edit: true,
	can_delete: true,
	is_redacted: false,
	track_count: 2,
	cover_urls: []
};
async function serverFixture(page: Page) {
	let mode: 'online' | 'offline' | 'gateway' | 'denied' | 'expired' = 'online';
	const requested: string[] = [],
		blocked: string[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const path = new URL(route.request().url()).pathname.slice(7),
			json = (data: unknown, status = 200) => route.fulfill({ status, json: data }),
			user = (route.request().headers().authorization ?? '').slice('Bearer '.length);
		if (mode === 'offline') {
			blocked.push(path);
			return route.abort();
		}
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: route.request().postDataJSON().username });
		if (path === '/me') return json({ id: user, display_name: user, role: 'user' });
		if (path === '/me/section-prefs') return json({ pages: { home: [] } });
		if (path === '/home') return json({ sections: [], refreshing: false });
		if (path.startsWith('/search')) {
			requested.push(route.request().url());
			if (mode === 'gateway') return route.abort('connectionrefused');
			if (mode === 'denied') return json({ error: { message: 'Search denied.' } }, 403);
			if (mode === 'expired')
				return json({ error: { code: 'UNAUTHORIZED', message: 'Session expired.' } }, 401);
			const row = {
				source: 'local',
				local_id: 'server-track',
				track_name: 'Online amber signal',
				artist: 'Online Artist',
				album: 'Online release'
			};
			if (path === '/search/tracks')
				return json({
					status: 'ok',
					results: [
						{
							...row,
							id: 'server-track',
							title: 'Online amber signal',
							artist: 'Online Artist',
							album: 'Online release'
						}
					]
				});
			if (path === '/search/albums')
				return json({
					status: 'ok',
					results: Array.from({ length: 24 }, (_, i) => ({
						id: 'a' + i,
						title: 'Online amber album ' + i,
						artist: 'Online Artist',
						art_missing: true
					}))
				});
			return json({
				albums: [{ id: 'online', title: 'Online amber album', artist: 'DN', art_missing: true }],
				artists: [],
				tracks: [],
				album_status: 'ok',
				artist_status: 'ok',
				track_status: 'ok'
			});
		}
		if (path === '/playlists') return json({ playlists: [normalList] });
		if (path === '/playlists/night')
			return json({
				...normalList,
				tracks: [0, 1].map((i) => ({
					id: 'entry' + i,
					track_name: 'Ámber song ' + i,
					artist_name: 'Ámber Sound',
					album_name: 'Ámber coast',
					source_type: 'local',
					library_file_id: 'amber' + i,
					track_source_id: 'amber' + i
				}))
			});
		if (path.includes('/artwork')) return route.fulfill({ status: 404 });
		if (await emptyBoardRead(route)) return;
		throw Error(path);
	});
	return { requested, blocked, set: (value: typeof mode) => (mode = value) };
}
async function seed(
	page: Page,
	who: string,
	force: boolean,
	count = 3,
	address = server,
	varied = false
) {
	const title = who === 'listener' && address.includes('device-search') ? 'Ámber' : 'Hidden amber';
	const tracks = Array.from({ length: count }, (_, i) => {
		const id = 'amber' + i,
			origin = (['downloaded', 'automatic', 'cached'] as const)[i % 3],
			album = title + ' coast' + (varied ? ' ' + String(i).padStart(2, '0') : ''),
			artist = title + ' Sound';
		const track = {
			id,
			title: title + ' song ' + String(i).padStart(2, '0'),
			album,
			artist,
			albumArtist: artist,
			albumId: varied ? 'coast' + i : 'coast',
			artistId: 'sound',
			genre: title + ' Jazz',
			streamUrl: '/api/v3/stream/local/' + id,
			artworkUrl: '/api/v3/library/albums/coast/artwork?size=500',
			year: 2021,
			discNumber: 1,
			trackNumber: i + 1,
			format: 'flac',
			favorite: i === 0,
			rating: 0
		};

		return { track, origin };
	});
	await seedOfflineMusic(page, address, who, force, tracks);
}
async function openSearch(page: Page, who = 'listener') {
	await localSignIn(page, server, who);
	await button(page, 'Search').click();
}
test('explicit offline Search finds saved metadata, local playlists, actions and edits without contacting DN', async ({
	page
}) => {
	const fixture = await serverFixture(page);
	await openSearch(page);
	await scope(page, 'Playlists').click();
	await button(page, 'Ámber radio').click();
	await page.getByRole('heading', { name: 'Ámber radio' }).waitFor();
	await page.keyboard.press('Escape');
	await button(page, 'Library').click();
	await button(page, 'Browse Playlists').click();
	await button(page, 'New playlist').click();
	await page
		.getByRole('dialog')
		.getByRole('button', { name: /^Smart playlist/ })
		.click();
	const creator = page.getByRole('dialog');
	await creator.getByLabel('Playlist name').fill('Amber stars');
	await chooseOption(creator.getByLabel('Playlist rating', { exact: true }), '5');
	await creator.getByRole('button', { name: 'Create smart playlist', exact: true }).click();
	await expect(button(page, 'Amber stars')).toBeVisible();
	await button(page, 'Search').click();
	await seed(page, 'hidden', false, 2);
	await seed(page, 'listener', false, 2, otherServer);
	await seed(page, 'listener', true);
	await expect(page.getByText('Searching music on this device.')).toBeVisible();
	fixture.set('offline');
	await box(page).fill('amber');
	await scope(page, 'Top results').click();
	for (const cat of ['Tracks', 'Artists', 'Albums', 'Genres', 'Playlists'])
		await expect(page.getByRole('region', { name: 'Device ' + cat.toLowerCase() })).toBeVisible();
	await expect(page.getByText(/Hidden amber/)).toHaveCount(0);
	const display = button(page, 'Search display');
	await display.click();
	await chooseOption(page.getByLabel('Display', { exact: true }), 'grid');
	await chooseOption(page.getByLabel('Grid columns'), '4');
	for (const cat of ['Tracks', 'Artists', 'Albums', 'Genres', 'Playlists'])
		await expect(
			page.getByRole('region', { name: 'Device ' + cat.toLowerCase() }).getByRole('list')
		).toHaveAttribute('data-columns', '4');
	await display.click();
	await scope(page, 'Artists').click();
	await expect(button(page, 'Search for Ámber Sound in Artists')).toBeVisible();
	await button(page, 'Ámber Sound').click();
	await expect(page.getByRole('heading', { name: 'Ámber Sound' })).toBeVisible();
	await expect(button(page, 'Play Ámber song 01')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(scope(page, 'Artists')).toHaveAttribute('aria-pressed', 'true');
	await expect(box(page)).toHaveValue('amber');
	await scope(page, 'Albums').click();
	await button(page, 'Ámber coast').click();
	await button(page, 'Back to search').click();
	await scope(page, 'Genres').click();
	await button(page, 'More options for Ámber Jazz').click();
	await page.getByRole('dialog').getByRole('button', { name: 'Open genre' }).click();
	await expect(button(page, 'Play Ámber song 00')).toBeVisible();
	await page.keyboard.press('Escape');
	await scope(page, 'Playlists').click();
	await button(page, 'Ámber radio').click();
	await expect(page.getByRole('heading', { name: 'Ámber radio' })).toBeVisible();
	await expect(button(page, 'Play Ámber song 02')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await scope(page, 'Songs').click();
	const legend = page.getByRole('group', { name: 'Offline availability' });
	await expect(legend).toHaveText('Available offline');
	await button(page, 'More options for Ámber song 00').click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('button', { name: 'Rate 5 stars' }).click();
	await expect(dialog.getByRole('button', { name: 'Rate 5 stars' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await scope(page, 'Playlists').click();
	await button(page, 'Amber stars').click();
	await expect(button(page, 'Play Ámber song 00')).toBeVisible();
	await expect(button(page, 'Play Ámber song 01')).toHaveCount(0);
	await button(page, 'Back to search').click();
	await scope(page, 'Songs').click();
	await button(page, 'Play Ámber song 00').click();
	await minimizePlayer(page);
	await expect(box(page)).toHaveValue('amber');
	expect(fixture.blocked).toEqual([]);
	fixture.set('online');
	await openSearch(page, 'hidden');
	await seed(page, 'hidden', true, 2);
	await box(page).fill('amber');
	await scope(page, 'Songs').click();
	await expect(button(page, 'Play Hidden amber song 01')).toBeVisible();
	await expect(button(page, 'Play Ámber song 00')).toHaveCount(0);
});
test('transport fallback uses cached covers only, keeps its query and retries DN without masking a forbidden or expired response', async ({
	page
}) => {
	const fixture = await serverFixture(page);
	await openSearch(page);
	await seed(page, 'listener', false);
	fixture.set('gateway');
	await box(page).fill('amber');
	await expect(page.getByText(/DN is unavailable/)).toBeVisible();
	await expect(button(page, 'Play Ámber song 00')).toBeVisible();
	fixture.set('offline');
	await scope(page, 'Albums').click();
	await expect(button(page, 'Ámber coast')).toBeVisible();
	expect(fixture.blocked).toEqual([]);
	fixture.set('online');
	await button(page, 'Retry DN').click();
	await expect(page.getByRole('button', { name: /Online amber album 0/ })).toBeVisible();
	await expect(box(page)).toHaveValue('amber');
	await expect(scope(page, 'Albums')).toHaveAttribute('aria-pressed', 'true');
	await page.route(
		server + '/api/v3/playlists',
		(route) => route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' }),
		{ times: 1 }
	);
	await scope(page, 'Playlists').click();
	await expect(page.getByText(/DN is unavailable/)).toBeVisible();
	await scope(page, 'Albums').click();
	await expect(button(page, 'Ámber coast')).toBeVisible();
	await button(page, 'Retry DN').click();
	await expect(page.getByRole('button', { name: /Online amber album 0/ })).toBeVisible();
	fixture.set('denied');
	await box(page).fill('amber jazz');
	await expect(page.getByRole('alert')).toContainText('Search denied.');
	await expect(button(page, 'Retry DN')).toHaveCount(0);
	fixture.set('expired');
	await box(page).fill('amber songs');
	await expect(page.getByLabel('Server address')).toBeVisible();
});

test('losing and regaining the physical network preserves a long Search, its scope and the local detail position', async ({
	page,
	context
}) => {
	const fixture = await serverFixture(page);
	await openSearch(page);
	await seed(page, 'listener', false, 88, server, true);
	await scope(page, 'Albums').click();
	await box(page).fill('amber');
	await expect(page.getByRole('button', { name: /Online amber album 0/ })).toBeVisible();
	await context.setOffline(true);
	fixture.set('offline');
	await expect(page.getByText('Searching music on this device.')).toBeVisible();
	const shelf = page.getByRole('region', { name: 'Device albums' });
	await expect(page.getByRole('region', { name: 'Search suggestions' })).toBeVisible();
	await shelf.getByRole('button', { name: 'More results' }).click();
	const tile = button(page, 'Ámber coast 66');
	await shelf.locator('[data-part=category-items]').evaluate((n) => {
		const m = n.closest('main')!,
			pitch =
				(n.clientHeight + parseFloat(getComputedStyle(n).rowGap)) /
				Math.ceil(Number(n.getAttribute('data-loaded')) / 2);
		m.scrollTop += n.getBoundingClientRect().top - m.getBoundingClientRect().top + 32 * pitch;
	});
	await tile.scrollIntoViewIfNeeded();
	await expect(tile).toBeInViewport({ ratio: 1 });
	const tileTop = () => tile.evaluate((el) => el.getBoundingClientRect().top);
	const before = await tileTop();
	await tile.click();
	await expect(page.getByRole('heading', { name: 'Ámber coast 66', exact: true })).toBeVisible();
	await button(page, 'Back to search').click();
	await expect(tile).toBeFocused();
	await expect.poll(async () => Math.abs((await tileTop()) - before)).toBeLessThan(6);
	expect(fixture.blocked).toEqual([]);
	await tile.click();
	const previous = fixture.requested.length;
	fixture.set('online');
	await context.setOffline(false);
	await expect(page.getByRole('heading', { name: 'Ámber coast 66', exact: true })).toBeVisible();
	expect(fixture.requested).toHaveLength(previous);
	await page.keyboard.press('Escape');
	await expect(page.getByRole('button', { name: /Online amber album 0/ })).toBeVisible();
	await expect(box(page)).toHaveValue('amber');
	await expect(scope(page, 'Albums')).toHaveAttribute('aria-pressed', 'true');
	await context.setOffline(true);
	fixture.set('offline');
	await expect(tile).toBeInViewport();
	await expect.poll(async () => Math.abs((await tileTop()) - before)).toBeLessThan(6);
	expect(fixture.blocked).toEqual([]);
});
