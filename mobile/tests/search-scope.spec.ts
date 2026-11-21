import { chooseOption } from './fixtures/inlineChoice';
import { expect, test } from '@playwright/test';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';

test('category changes keep the query, page the selected bucket, and open genres and playlists inside Search', async ({
	page
}) => {
	const server = 'https://scope.example/music';
	const searched: string[] = [];
	const list = { id: 'rail', name: 'Rail journeys', cover_urls: [], song_count: 0, is_owner: true };
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url()),
			path = url.pathname.split('/api/v3')[1];
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers')
			return json({ local: true, oidc: false, plex: false, jellyfin: false });
		if (path === '/auth/login') return json({ token: 'scoped' });
		expect(req.headers().authorization).toBe('Bearer scoped');
		expect(req.method()).toBe('GET');
		if (path === '/me') return json({ id: 'listener', display_name: 'Listener', role: 'user' });
		if (path === '/discover')
			return json({
				sections: [
					{
						key: 'genre_list',
						content: {
							shape: 'shelf',
							shelf: {
								type: 'genres',
								title: 'Genres',
								items: [{ kind: 'genre', name: 'Rail folk' }]
							}
						}
					}
				]
			});
		if (path === '/home/genre/Rail%20folk')
			return json({ genre: 'Rail folk', library: { albums: [], artists: [] }, popular: null });
		if (path === '/playlists')
			return json({ playlists: [list, { id: 'other', name: 'Rail private', is_redacted: true }] });
		if (path === '/playlists/rail') return json({ ...list, tracks: [] });
		if (path === '/search/suggest')
			return json({ status: 'ok', results: [{ title: 'Rail', kind: 'artist' }] });
		if (path.startsWith('/search')) {
			expect(url.searchParams.get('q')).toBe('rail');
			searched.push(path);
			if (path === '/search')
				return json({
					albums: [],
					artists: [],
					tracks: [],
					album_status: 'ok',
					artist_status: 'ok',
					track_status: 'ok'
				});
			expect(url.searchParams.get('limit')).toBe('24');
			const offset = Number(url.searchParams.get('offset'));
			if (path === '/search/artists')
				return json({
					status: 'ok',
					results: Array.from({ length: offset === 0 ? 24 : 1 }, (_, i) => ({
						title: 'Rail artist ' + (i + offset),
						id: 'a' + (i + offset)
					}))
				});
			if (path === '/search/albums')
				return json({
					status: 'ok',
					results: [{ title: 'Rail album', id: 'album', art_missing: true }]
				});
			if (path === '/search/tracks')
				return json({
					status: 'ok',
					results: [
						{
							title: 'Rail song',
							id: 'song',
							track: { album_title: 'Rail album' },
							art_missing: true
						}
					]
				});
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected search fixture endpoint ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'Music' })
		.getByRole('button', { name: 'Search' })
		.click();
	const scopes = page.getByRole('group', { name: 'Search category' });
	await page.setViewportSize({ width: 375, height: 812 });
	const tops = await scopes
		.getByRole('button')
		.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
	expect(tops).toEqual([tops[0], tops[0], tops[0], tops[5], tops[5], tops[5]]);
	expect(tops[5]).toBeGreaterThan(tops[0]);
	const input = page.getByRole('searchbox', { name: 'Search music' });
	await input.fill('rail');
	await expect(page.getByRole('button', { name: 'Search for Rail in Artists' })).toBeVisible();
	await input.press('Enter');
	await input.fill('');
	const history = page.getByRole('region', { name: 'Recent searches' });
	await history.getByRole('button', { name: 'Search for rail in Top results' }).click();
	await expect(page.getByText('No matches for “rail”.')).toBeVisible();
	await scopes.getByRole('button', { name: 'Artists' }).click();
	await expect(page.getByRole('button', { name: 'Rail artist 0', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Next results' }).click();
	await expect(page.getByRole('button', { name: 'Rail artist 24' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Next results' })).toBeDisabled();
	await page.getByRole('button', { name: 'Previous results' }).click();
	await expect(page.getByRole('button', { name: 'Rail artist 0', exact: true })).toBeVisible();
	await scopes.getByRole('button', { name: 'Albums' }).click();
	await expect(page.getByText('Rail album', { exact: true })).toBeVisible();
	await scopes.getByRole('button', { name: 'Songs' }).click();
	await expect(page.getByText('Rail song', { exact: true })).toBeVisible();
	await scopes.getByRole('button', { name: 'Genres' }).click();
	await page.getByRole('button', { name: 'Rail folk', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Rail folk' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(input).toHaveValue('rail');
	await expect(scopes.getByRole('button', { name: 'Genres' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await input.fill('Rail folk');
	await expect(page.getByRole('button', { name: /as a genre/ })).toHaveCount(0);
	await input.fill('rail');
	await scopes.getByRole('button', { name: 'Playlists' }).click();
	await expect(page.getByRole('button', { name: 'Rail private', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Rail journeys' }).click();
	await expect(page.getByRole('heading', { name: 'Rail journeys' })).toBeVisible();
	await page.getByRole('button', { name: 'Back to search' }).click();
	await expect(input).toHaveValue('rail');
	expect(searched).toEqual([
		'/search',
		'/search/artists',
		'/search/artists',
		'/search/artists',
		'/search/albums',
		'/search/tracks'
	]);
});

test('recent search history deduplicates submitted queries and stays within each listener and server', async ({
	page
}) => {
	const origin = 'https://history.example';
	await page.route(origin + '/**', async (r) => {
		const path = new URL(r.request().url()).pathname.split('/api/v3')[1];
		if (path === '/auth/providers') return r.fulfill({ json: { local: true, oidc: false } });
		if (path === '/auth/login')
			return r.fulfill({ json: { token: r.request().postDataJSON().username } });
		if (path === '/me')
			return r.fulfill({
				json: {
					id: r.request().headers().authorization.slice(7),
					display_name: 'Listener',
					role: 'user'
				}
			});
		if (path === '/search')
			return r.fulfill({
				json: {
					albums: [],
					artists: [],
					tracks: [],
					album_status: 'ok',
					artist_status: 'ok',
					track_status: 'ok'
				}
			});
		if (await emptyBoardRead(r)) return;
		return r.fulfill({ status: 404, json: {} });
	});
	const search = async (account: string, path = '/one') => {
		await localSignIn(page, origin + path, account);
		await page
			.getByRole('navigation', { name: 'Music' })
			.getByRole('button', { name: 'Search' })
			.click();
	};
	const box = page.getByRole('searchbox', { name: 'Search music' });
	const history = page.getByRole('region', { name: 'Recent searches' });
	await search('alice');
	for (const term of ['tide', 'Tide']) {
		await box.fill(term);
		await box.press('Enter');
	}
	await box.fill('unfinished');
	await box.fill('');
	await expect(history.getByRole('button', { name: /Search for/ })).toHaveCount(1);
	await search('bob');
	await expect(history).toHaveCount(0);
	await search('alice', '/other');
	await expect(history).toHaveCount(0);
	await search('alice');
	await expect(
		history.getByRole('button', { name: 'Search for Tide in Top results' })
	).toBeVisible();
	await history.getByRole('button', { name: 'Clear history' }).click();
	await expect(history).toHaveCount(0);
});

test('each search scope remembers its list, grid width and spacing for the signed-in listener', async ({
	page
}) => {
	const server = 'https://display.example';
	const albums = [
		{ id: 'stations', title: 'Rail stations', artist: 'Rail quartet', art_missing: true }
	];
	const artists = [{ id: 'quartet', title: 'Rail quartet', art_missing: true }];
	const localTrack = {
		id: 'ride',
		title: 'Rail ride',
		artist: 'Rail quartet',
		track: { album_title: 'Rail stations', duration_seconds: 151 },
		art_missing: true
	};
	const remoteTrack = {
		musicbrainz_id: 'remote-recording',
		title: 'Rail routes',
		artist: 'Rail quartet',
		remote_track: { album_title: 'Routes', release_mbid: 'release', release_group_mbid: 'group' },
		art_missing: true
	};
	const search = {
		albums,
		artists,
		tracks: [localTrack, remoteTrack],
		album_status: 'ok',
		artist_status: 'ok',
		track_status: 'ok'
	};
	let queries = 0,
		requested = 0;
	await page.route(server + '/api/v3/**', async (route) => {
		const request = route.request(),
			path = new URL(request.url()).pathname.slice('/api/v3'.length);
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: request.postDataJSON().username });
		if (path === '/me')
			return json({
				id: request.headers().authorization.slice(7),
				role: 'user',
				display_name: 'Listener'
			});
		if (path === '/search') {
			queries++;
			return json(search);
		}
		if (path === '/search/artists') {
			queries++;
			return json({ status: 'ok', results: artists });
		}
		if (path === '/requests/tracks') {
			requested++;
			expect(request.postDataJSON()).toMatchObject({ recording_mbid: 'remote-recording' });
			return json({ status: 'added' });
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected fixture request ' + path);
	});
	await page.setViewportSize({ width: 320, height: 700 });
	async function open(account: string) {
		await localSignIn(page, server, account);
		await page
			.getByRole('navigation', { name: 'Music' })
			.getByRole('button', { name: 'Search' })
			.click();
		await page.getByRole('searchbox', { name: 'Search music' }).fill('rail');
	}
	const results = (name: string) => page.getByRole('list', { name, exact: true });
	const settings = page.getByRole('button', { name: 'Search display' });
	await open('alice');
	const categories = page.getByRole('group', { name: 'Search category' });
	const groups = ['Artists results', 'Albums results', 'Tracks results', 'Songs to request'];
	for (const name of groups) await expect(results(name)).toHaveAttribute('data-layout', 'list');
	await settings.click();
	const before = queries;
	await chooseOption(page.getByLabel('Display', { exact: true }), 'grid');
	await chooseOption(page.getByLabel('Grid columns'), '6');
	await page.getByLabel('Compact rows').check();
	for (const name of groups) {
		const group = results(name);
		await expect(group).toHaveAttribute('data-columns', '6');
		await expect(group).toHaveClass(/compact/);
		expect(
			await group.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
		).toBe(6);
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	expect(queries).toBe(before);
	const remote = results('Songs to request'),
		request = remote.getByRole('button', { name: 'Request song Rail routes' });
	await request.click();
	await expect(remote.getByRole('button', { name: 'Requested Rail routes' })).toBeDisabled();
	expect(requested).toBe(1);
	await categories.getByRole('button', { name: 'Artists', exact: true }).click();
	await expect(results('Artists results')).toHaveAttribute('data-columns', '3');
	await chooseOption(page.getByLabel('Display', { exact: true }), 'list');
	await categories.getByRole('button', { name: 'Top results', exact: true }).click();
	await expect(results('Artists results')).toHaveAttribute('data-columns', '6');
	await open('bob');
	await expect(results('Artists results')).toHaveAttribute('data-layout', 'list');
	await open('alice');
	await expect(results('Artists results')).toHaveAttribute('data-columns', '6');
	await categories.getByRole('button', { name: 'Artists', exact: true }).click();
	await expect(results('Artists results')).toHaveAttribute('data-layout', 'list');
});
