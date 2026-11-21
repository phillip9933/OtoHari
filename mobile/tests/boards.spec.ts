import { chooseOption } from './fixtures/inlineChoice';
import { expect, test, type Page } from '@playwright/test';
const server = 'https://boards.example/dn';

async function fixture(page: Page) {
	let username = 'alex',
		loginCount = 0;
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			path = new URL(req.url()).pathname.slice('/dn/api/v3'.length);
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') {
			username = req.postDataJSON().username;
			loginCount++;
			return json({ token: 'test-' + loginCount });
		}
		expect(req.headers().authorization).toBe('Bearer test-' + loginCount);
		if (path === '/me')
			return json({ id: 'id-' + username, display_name: 'Listener', role: 'user' });
		if (path === '/library/albums')
			return json({
				items: [{ id: 'album', title: 'Night train', artist_name: 'Southerly', art_missing: true }],
				next: null
			});
		if (path === '/library/artists')
			return json({ items: [{ id: 'artist', name: 'Southerly', album_count: 1 }], next: null });
		if (path === '/home' || path === '/discover') return json({ sections: [], refreshing: false });
		if (path === '/me/section-prefs') return json({ pages: { home: [], discover: [] } });
		if (path === '/auth/logout') return route.fulfill({ status: 204 });
		if (path === '/library/genres' || path === '/genres') return json({ items: [], genres: [] });
		return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
	});
}
async function login(page: Page, name = 'alex') {
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill(name);
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
}
function button(page: Page, name: string) {
	return page.getByRole('button', { name, exact: true });
}
const order = (page: Page) =>
	page
		.locator('[data-widget]:visible h2')
		.allTextContents()
		.then((rows) => rows.map((s) => s.trim()));
async function edit(page: Page, layout: string) {
	await button(page, 'Settings').click();
	await button(page, layout + ' layout').click();
	await expect(page.getByRole('heading', { name: layout + ' layout', exact: true })).toBeVisible();
}
async function save(page: Page) {
	await button(page, 'Save layout').click();
	await button(page, 'Back').click();
}
async function addToHome(page: Page, label: string) {
	await edit(page, 'Home');
	await button(page, 'Add ' + label).click();
	await save(page);
}
test('a listener arranges sections independently and keeps the layout after signing in again', async ({
	page
}) => {
	await fixture(page);
	await page.goto('/');
	await login(page);
	await expect(button(page, 'Browse Recently added')).toBeVisible();
	await button(page, 'Browse Recently added').click();
	await button(page, 'Home').click();
	await edit(page, 'Home');
	await button(page, 'Remove Recently played').click();
	await button(page, 'Add Artists').click();
	await button(page, 'Move Artists up').click();
	await expect(page.getByRole('combobox', { name: 'Position', exact: true })).toHaveCount(0);
	await expect(page.getByLabel('Section title')).toHaveCount(0);
	await button(page, 'Move Artists up').click();
	await page.getByLabel('Show a preview').uncheck();
	await save(page);
	await expect.poll(() => order(page)).toEqual(['Artists', 'Recently added', 'Top picks for you']);
	await expect(page.locator('[data-widget="library-artists"]')).not.toContainText('Southerly');
	await button(page, 'Browse Artists').click();
	await expect(page.getByRole('heading', { name: 'Artists', exact: true })).toBeVisible();
	await expect(button(page, 'Southerly 1 album')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(button(page, 'Browse Artists')).toBeVisible();
	await expect(button(page, 'Home layout')).toHaveCount(0);
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	await expect(button(page, 'Browse Artists')).toBeVisible();
	await edit(page, 'Library');
	await button(page, 'Remove Artists').click();
	await save(page);
	await expect(button(page, 'Browse Artists')).toHaveCount(0);
	await button(page, 'Browse Playlists').click();
	await addToHome(page, 'Playlists');
	await button(page, 'Home').click();
	await expect
		.poll(() => order(page))
		.toEqual(['Artists', 'Recently added', 'Top picks for you', 'Playlists']);
	await edit(page, 'Home');
	await button(page, 'Restore default layout').click();
	await page.keyboard.press('Escape');
	await button(page, 'Back').click();
	await expect(button(page, 'Browse Artists')).toBeVisible();
	await page.reload();
	await login(page);
	await expect(button(page, 'Browse Artists')).toBeVisible();
	await page.reload();
	await login(page, 'blair');
	await expect(button(page, 'Browse Artists')).toHaveCount(0);
	await expect(button(page, 'Browse Recently played')).toBeVisible();
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	await expect(button(page, 'Browse Artists')).toBeVisible();
});
test('an empty layout remains editable and Discover selections can be shared with Home', async ({
	page
}) => {
	await fixture(page);
	await page.goto('/');
	await login(page);
	await button(page, 'Discover').click();
	await edit(page, 'Discover');
	await page.getByLabel('Find a section').fill('trending artists');
	await button(page, 'Add Trending artists').click();
	await page.getByLabel('Show a preview').uncheck();
	await save(page);
	await button(page, 'Browse Trending artists').click();
	await addToHome(page, 'Trending artists');
	await button(page, 'Home').click();
	await expect(button(page, 'Browse Trending artists')).toBeVisible();
	await edit(page, 'Home');
	while (await page.locator('[data-section-id]').count())
		await page
			.locator('[data-section-id]')
			.first()
			.getByRole('button', { name: /^Remove / })
			.click();
	await save(page);
	await expect(page.getByText('Choose sections for Home in Settings.')).toBeVisible();
	await button(page, 'Discover').click();
	await expect(button(page, 'Browse Trending artists')).toBeVisible();
	await button(page, 'Home').click();
	await edit(page, 'Home');
	await button(page, 'Restore default layout').click();
	await save(page);
	await expect(button(page, 'Browse Recently added')).toBeVisible();
});

test('Top picks and library entries honor the chosen columns and density on a 320px phone', async ({
	page
}) => {
	await page.setViewportSize({ width: 1100, height: 800 });
	await fixture(page);
	const albums = Array.from({ length: 12 }, (_, i) => ({
		id: 'record-' + i,
		title: 'Album ' + (i + 1),
		artist_name: 'Board artist',
		art_missing: true
	}));
	const picks = albums.map((a) => ({
		album: { local_id: a.id, title: a.title, artist_name: a.artist_name, in_library: true },
		match_pct: 81,
		reasons: ['Your listening history']
	}));
	await page.route(server + '/api/v3/discover', (r) =>
		r.fulfill({
			json: {
				sections: [
					{
						key: 'top_picks',
						content: { shape: 'picks', picks: { title: 'Top picks', items: picks } }
					}
				],
				refreshing: false
			}
		})
	);
	await page.route(server + '/api/v3/library/albums?**', (r) =>
		r.fulfill({
			json: {
				items: albums.slice(0, Number(new URL(r.request().url()).searchParams.get('limit'))),
				next: null
			}
		})
	);
	await page.route(server + '/api/v3/library/tracks?**', (r) =>
		r.fulfill({
			json: {
				items: albums.map((a, i) => ({
					...a,
					id: 'track-' + i,
					title: 'Song ' + (i + 1),
					album_title: a.title
				})),
				next: null
			}
		})
	);
	await page.route(server + '/api/v3/playlists', (r) =>
		r.fulfill({
			json: {
				playlists: [
					{ id: 'mine', name: 'Travel days', cover_urls: [], track_count: 3, is_redacted: false }
				]
			}
		})
	);
	await page.goto('/');
	await login(page);
	const shelf = (id: string) => page.locator('[data-board]:visible [data-widget="' + id + '"]');
	const homePicks = shelf('discover-top_picks');
	await homePicks.scrollIntoViewIfNeeded();
	await expect(homePicks.getByRole('button', { name: /Album 1 Board artist/ })).toBeVisible();
	await expect(homePicks).toContainText('81% match');
	await edit(page, 'Home');
	await button(page, 'Customize Top picks for you').click();
	await chooseOption(page.getByRole('combobox', { name: 'Display', exact: true }), 'grid');
	await chooseOption(page.getByRole('combobox', { name: 'Columns', exact: true }), '6');
	await chooseOption(page.getByRole('combobox', { name: 'Preview rows', exact: true }), '2');
	await expect(page.getByRole('combobox', { name: 'Column size', exact: true })).toHaveCount(0);
	await chooseOption(page.getByRole('combobox', { name: 'Row density', exact: true }), 'compact');
	await save(page);
	await homePicks.scrollIntoViewIfNeeded();
	const tiles = homePicks.locator('[data-preview-item]');
	await expect(tiles).toHaveCount(12);
	await expect(homePicks.locator('[data-preview]')).toHaveAttribute('data-density', 'compact');
	await button(page, 'Browse Top picks for you').click();
	const expanded = page.locator('[data-collection="expanded"]:visible');
	await expect(expanded).toHaveAttribute('data-preview', 'grid');
	await expect(expanded.locator('[data-preview-item]')).toHaveCount(12);
	await expect(expanded.getByRole('button', { name: 'Hidden albums' })).toBeVisible();
	await button(page, 'Back to Home').click();
	await tiles.first().getByRole('button').click();
	await expect(page.getByRole('heading', { name: 'Album 1', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.setViewportSize({ width: 320, height: 640 });
	await expect(tiles).toHaveCount(12);
	const layout = await homePicks.locator('.preview-items').evaluate((el) => {
		const cols = getComputedStyle(el).gridTemplateColumns.split(' ').length;
		return {
			cols,
			rows: new Set([...el.children].map((cell) => cell.getBoundingClientRect().top)).size,
			minWidth: Math.min(...[...el.children].map((cell) => cell.getBoundingClientRect().width)),
			gap: getComputedStyle(el).rowGap,
			fits: el.scrollWidth <= el.clientWidth + 1
		};
	});
	expect(layout.cols).toBe(6);
	expect(layout.rows).toBe(2);
	expect(layout.minWidth).toBeGreaterThanOrEqual(44);
	expect(layout.gap).toBe('6px');
	expect(layout.fits).toBe(true);
	await edit(page, 'Home');
	await button(page, 'Customize Top picks for you').click();
	await chooseOption(page.getByRole('combobox', { name: 'Display', exact: true }), 'list');
	await chooseOption(page.getByRole('combobox', { name: 'Columns', exact: true }), '2');
	await chooseOption(page.getByRole('combobox', { name: 'Row density' }), 'spacious');
	await save(page);
	await homePicks.scrollIntoViewIfNeeded();
	await expect(tiles).toHaveCount(4);
	await expect(homePicks.locator('.preview-items')).toHaveCSS('row-gap', '16px');
	await expect(homePicks.locator('[data-preview]')).toHaveAttribute('data-preview', 'list');
	await button(page, 'Discover').click();
	const discoverPicks = shelf('discover-top_picks');
	await expect(discoverPicks.locator('[data-preview]')).toHaveAttribute('data-preview', 'grid');
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	await edit(page, 'Library');
	await button(page, 'Customize Tracks').click();
	await chooseOption(page.getByRole('combobox', { name: 'Display', exact: true }), 'grid');
	await chooseOption(page.getByRole('combobox', { name: 'Columns', exact: true }), '2');
	await save(page);
	const artists = shelf('library-artists');
	await artists.scrollIntoViewIfNeeded();
	await expect(artists.getByRole('button', { name: 'Southerly 1 album' })).toBeVisible();
	const songs = shelf('library-tracks');
	await songs.scrollIntoViewIfNeeded();
	await expect(songs.getByRole('button', { name: 'Play Song 1', exact: true })).toBeVisible();
	await expect(songs.getByRole('button', { name: 'More options for Song 1' })).toBeVisible();
	await button(page, 'Browse Tracks').click();
	await expect(expanded).toHaveAttribute('data-preview', 'grid');
	await expect(expanded.locator('[data-preview-item]')).toHaveCount(12);
	await expect(expanded.getByLabel('Filter songs')).toBeVisible();
	await expect(expanded.getByRole('button', { name: 'Play all', exact: true })).toBeVisible();
	await expanded.getByRole('button', { name: 'More options for Song 1', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeVisible();
	await button(page, 'Close').click();
	await button(page, 'Back to Library').click();
	const playlists = shelf('library-playlists');
	await playlists.scrollIntoViewIfNeeded();
	await expect(playlists.getByRole('button', { name: /Travel days/ })).toBeVisible();
	await page.reload();
	await login(page);
	await homePicks.scrollIntoViewIfNeeded();
	await expect(tiles).toHaveCount(4);
	await expect(homePicks.locator('[data-preview]')).toHaveAttribute('data-preview', 'list');
	await page.setViewportSize({ width: 1100, height: 800 });
	await expect(tiles).toHaveCount(4);
});

test('a legacy six-column list keeps its count and each track action fits on a narrow shelf', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 700 });
	await fixture(page);
	await page.addInitScript((server) => {
		const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'id-alex', 'home']);
		localStorage.setItem(
			key,
			JSON.stringify([
				{
					id: 'library-tracks',
					title: '',
					preview: true,
					display: {
						layout: 'list',
						columns: 2,
						listColumns: 6,
						columnSize: 'large',
						rows: 2,
						density: 'spacious'
					}
				}
			])
		);
	}, server);
	await page.route(server + '/api/v3/library/tracks?**', (r) =>
		r.fulfill({
			json: {
				items: Array.from({ length: 12 }, (_, i) => ({
					id: String(i),
					title: 'Long song title ' + i,
					artist_name: 'Long artist name',
					art_missing: true
				})),
				next: null,
				total: 12
			}
		})
	);
	await page.goto('/');
	await login(page);
	const shelf = page.locator('[data-widget="library-tracks"] .preview-items');
	await expect(shelf.locator('[data-preview-item]')).toHaveCount(12);
	const bounds = await shelf.evaluate((el) => {
		const items = [...el.querySelectorAll('[data-preview-item]')];
		return {
			rows: new Set(items.map((x) => x.getBoundingClientRect().top)).size,
			inside: items.every((item) => {
				const cell = item.getBoundingClientRect();
				return [...item.querySelectorAll('button')].every((b) => {
					const r = b.getBoundingClientRect();
					return r.width >= 44 && r.x >= cell.left - 1 && r.right <= cell.right + 1;
				});
			}),
			width: el.scrollWidth - el.clientWidth
		};
	});
	expect(bounds).toEqual({ rows: 2, inside: true, width: 0 });
	await shelf
		.getByRole('button', { name: 'More options for Long song title 5', exact: true })
		.click();
	await expect(page.getByRole('dialog', { name: 'Long song title 5' })).toBeVisible();
});

test('visible shelves share the Discover response and limit overlapping cover requests', async ({
	page
}) => {
	await page.setViewportSize({ width: 1000, height: 1400 });
	await fixture(page);
	await page.addInitScript((server) => {
		const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'id-alex', 'home']);
		const display = { layout: 'list', rows: 6, density: 'compact' };
		localStorage.setItem(
			key,
			JSON.stringify(
				['top_picks', 'fresh_releases'].map((key) => ({
					id: 'discover-' + key,
					title: '',
					preview: true,
					display
				}))
			)
		);
	}, server);
	const albums = Array.from({ length: 6 }, (_, i) => ({
		kind: 'album',
		local_id: 'shared-' + i,
		title: 'Record ' + (i + 1),
		artist_name: 'Performer'
	}));
	let pages = 0,
		active = 0,
		peak = 0;
	const covers: string[] = [];
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(server + '/api/v3/discover', (r) => {
		pages++;
		return r.fulfill({
			json: {
				sections: ['top_picks', 'fresh_releases'].map((key) => ({
					key,
					content: { shape: 'shelf', shelf: { title: 'New', items: albums } }
				})),
				refreshing: false
			}
		});
	});
	await page.route(server + '/api/v3/library/albums/*/artwork?**', async (r) => {
		active++;
		peak = Math.max(peak, active);
		covers.push(new URL(r.request().url()).pathname);
		await hold;
		await r.fulfill({ status: 404, json: {} });
		active--;
	});
	await page.goto('/');
	await login(page);
	try {
		await expect(page.locator('[data-preview-item]')).toHaveCount(12);
		await expect.poll(() => covers.length).toBe(4);
	} finally {
		release();
	}
	await expect.poll(() => covers.length).toBe(6);
	expect(peak).toBeLessThanOrEqual(4);
	expect(new Set(covers).size).toBe(6);
	expect(pages).toBe(1);
});

test('visible shelves load on mount and resume while intersection callbacks are deferred', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 540 });
	await fixture(page);
	const reads: string[] = [];
	page.on('request', (req) => {
		if (req.url().startsWith(server + '/api/v3/library/')) reads.push(new URL(req.url()).pathname);
	});
	await page.addInitScript((server) => {
		window.IntersectionObserver = class extends IntersectionObserver {
			observe(target: Element) {
				if (!target.matches('[data-preview]')) super.observe(target);
			}
		};
		const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'id-alex', 'home']);
		const shortcuts = [
			'popular_albums',
			'trending_artists',
			'your_top_albums',
			'following',
			'releases',
			'concerts',
			'top_picks',
			'weekly_exploration',
			'anniversaries',
			'missing_essentials',
			'rediscover',
			'genre_list'
		];
		localStorage.setItem(
			key,
			JSON.stringify([
				{ id: 'library-recently-added', preview: true },
				...shortcuts.map((id) => ({ id: 'discover-' + id, preview: false })),
				{ id: 'library-artists', preview: true }
			])
		);
	}, server);
	await page.goto('/');
	await login(page);
	await expect(page.getByRole('button', { name: 'Night train Southerly' })).toBeVisible();
	const artists = page.locator('[data-widget="library-artists"]');
	await expect(artists.locator('[data-preview-item]')).toHaveCount(0);
	expect(reads).not.toContain('/dn/api/v3/library/artists');
	await artists.evaluate((el) => {
		el.scrollIntoView({ block: 'center' });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect(artists.getByRole('button', { name: 'Southerly 1 album' })).toBeVisible();
	expect(reads.filter((path) => path === '/dn/api/v3/library/artists')).toHaveLength(1);
});

test('a saved five-star filter can appear on both boards and shared edits commit only when saved', async ({
	page
}) => {
	await fixture(page);
	const urls: string[] = [];
	await page.route(server + '/api/v3/library/tracks?**', async (route) => {
		const url = new URL(route.request().url());
		urls.push(url.search);
		const five = url.searchParams.get('rating') === '5';
		await route.fulfill({
			json: {
				total: 1,
				next: null,
				items: [
					{
						id: 'one',
						title: five ? 'Five star song' : 'Any song',
						artist_name: 'Southerly',
						album_title: 'Night train',
						art_missing: true
					}
				]
			}
		});
	});
	await page.goto('/');
	await login(page);
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	await button(page, 'Browse Tracks').click();
	await page.getByText('Rating and format', { exact: true }).click();
	await chooseOption(page.getByLabel('Your rating'), '5');
	await button(page, 'Save filters as section').click();
	let modal = page.getByRole('dialog');
	await expect(modal.getByLabel('Section rating', { exact: true })).toHaveAttribute(
		'data-value',
		'5'
	);
	await modal.getByLabel('Section name').fill('My five stars');
	await modal.getByRole('button', { name: 'Create section' }).click();
	await button(page, 'Browse My five stars').click();
	await expect(button(page, 'Play Five star song')).toBeVisible();
	expect(urls.some((q) => q.includes('rating=5') && q.includes('rating_mode=at_least'))).toBe(true);
	await button(page, 'Home').click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	await expect(button(page, 'Browse My five stars')).toHaveCount(0);
	await addToHome(page, 'My five stars');
	await expect(button(page, 'Browse My five stars')).toBeVisible();
	await edit(page, 'Home');
	await button(page, 'Customize My five stars').click();
	await button(page, 'Edit filters').click();
	modal = page.getByRole('dialog');
	await modal.getByLabel('Section name').fill('Discard me');
	await modal.getByRole('button', { name: 'Apply filters' }).click();
	await button(page, 'Cancel').click();
	await button(page, 'Back').click();
	await expect(button(page, 'Browse My five stars')).toBeVisible();
	await edit(page, 'Home');
	await button(page, 'Customize My five stars').click();
	await button(page, 'Edit filters').click();
	modal = page.getByRole('dialog');
	await modal.getByLabel('Section name').fill('Favorite artists');
	await chooseOption(modal.getByLabel('Library collection'), 'artists');
	await modal.getByLabel('Favorites only').check();
	await modal.getByRole('button', { name: 'Apply filters' }).click();
	await save(page);
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	await button(page, 'Browse Favorite artists').click();
	await expect(button(page, 'Southerly 1 album')).toBeVisible();
	await page.reload();
	await login(page, 'blair');
	await edit(page, 'Home');
	await expect(button(page, 'Add Favorite artists')).toHaveCount(0);
	await button(page, 'Cancel').click();
	await button(page, 'Back').click();
	await page.reload();
	await login(page);
	await edit(page, 'Library');
	await button(page, 'Customize Favorite artists').click();
	await button(page, 'Edit filters').click();
	modal = page.getByRole('dialog');
	await modal.getByRole('button', { name: 'Delete saved section' }).click();
	await modal.getByRole('button', { name: 'Delete section' }).click();
	await save(page);
	await button(page, 'Home').click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	await expect(button(page, 'Browse Favorite artists')).toHaveCount(0);
});

test('selection applies playlist actions to chosen items across library shelves and individual playlist entries', async ({
	page
}) => {
	await fixture(page);
	const album = {
		id: 'album',
		title: 'Night train',
		artist_name: 'Southerly',
		art_missing: true
	};
	const song = (id: string, title: string) => ({
		id,
		title,
		artist_name: 'Southerly',
		album_title: 'Into town',
		album_id: 'album',
		disc_number: 1,
		track_number: 1,
		art_missing: true
	});
	const list = {
		id: 'road',
		name: 'Road',
		is_owner: true,
		can_edit: true,
		cover_urls: [],
		track_count: 3
	};
	const writes: string[][] = [];
	const details = () => ({
		...list,
		tracks: [
			{
				id: 'one',
				source_type: 'local',
				track_source_id: 's3',
				track_name: 'Set one',
				artist_name: 'Southerly',
				album_name: 'Into town'
			},
			{
				id: 'two',
				source_type: 'local',
				track_source_id: 's3',
				track_name: 'Set one',
				artist_name: 'Southerly',
				album_name: 'Into town'
			},
			{
				id: 'three',
				track_name: 'Unavailable',
				artist_name: 'Southerly',
				album_name: 'Into town',
				available_sources: []
			}
		]
	});
	await page.route(server + '/api/v3/library/albums*', (route) =>
		route.fulfill({ json: { items: [album], total: 1 } })
	);
	await page.route(server + '/api/v3/library/albums/match/album?**', (route) =>
		route.fulfill({ json: { items: [song('s1', 'After hours')], total: 1 } })
	);
	await page.route(server + '/api/v3/library/tracks?**', (route) =>
		route.fulfill({
			json: {
				items: [song('s2', 'Daybreak'), song('s3', 'Set one')],
				total: 2
			}
		})
	);
	await page.route(server + '/api/v3/playlists', (route) =>
		route.fulfill({ json: { playlists: [list] } })
	);
	await page.route(server + '/api/v3/playlists/road', (route) =>
		route.fulfill({ json: details() })
	);
	await page.route(server + '/api/v3/playlists/road/tracks', (route) => {
		writes.push(
			route
				.request()
				.postDataJSON()
				.tracks.map((row: { track_source_id: string }) => row.track_source_id)
		);
		return route.fulfill({
			json: { tracks: writes.at(-1)!.map((id) => ({ track_source_id: id })) }
		});
	});
	await page.goto('/');
	await login(page);
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	const board = page.locator('[data-board=library]');
	await board
		.locator('[data-widget=library-albums]')
		.getByRole('button', { name: /Night train/ })
		.scrollIntoViewIfNeeded();
	await board
		.locator('[data-widget=library-albums] [data-selectable]')
		.filter({ hasText: 'Night train' })
		.first()
		.press('Shift+Space');
	const songs = board.locator('[data-widget=library-tracks]');
	await songs.scrollIntoViewIfNeeded();
	await songs.getByRole('button', { name: 'Select Daybreak' }).click();
	const actions = page.getByRole('group', { name: 'Selection actions' });
	await expect(actions.getByText('2 selected')).toBeVisible();
	await actions.getByRole('button', { name: 'Add to playlist' }).click();
	let modal = page.getByRole('dialog');
	await modal.getByRole('button', { name: 'Add 2 tracks' }).click();
	await modal.getByRole('button', { name: 'Done' }).click();
	expect(writes).toEqual([['s1', 's2']]);
	await page.keyboard.press('Escape');
	await expect(actions).toHaveCount(0);
	await button(page, 'Browse Playlists').click();
	await page.getByRole('button', { name: /Road 3 tracks/ }).click();
	await page.locator('[data-selectable]:visible').first().press('Shift+Space');
	await button(page, 'Select loaded').click();
	await expect(actions.getByText('2 selected')).toBeVisible();
	await actions.getByRole('button', { name: 'Add to playlist' }).click();
	modal = page.getByRole('dialog');
	await modal.getByRole('button', { name: 'Add 2 tracks' }).click();
	await modal.getByRole('button', { name: 'Done' }).click();
	expect(writes[1]).toEqual(['s3', 's3']);
});
