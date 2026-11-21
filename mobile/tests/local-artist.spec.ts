import { minimizePlayer } from './fixtures/minimizePlayer';
import { chooseOption } from './fixtures/inlineChoice';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test('a local artist links credited songs, paginated guest appearances and the DN web artist', async ({
	page,
	context
}) => {
	const server = 'https://artist.example/music',
		artistId = 'guest artist',
		artistPath = '/library/artists/' + encodeURIComponent(artistId);
	const release = (id: string, title: string, artist_name: string) => ({
		id,
		title,
		artist_name,
		art_missing: true,
		favorite: false
	});
	const song = {
		id: 'guest-song',
		title: 'After Hours',
		album_id: 'compilation',
		album_title: 'Night Cohort',
		artist_name: 'Guest Artist',
		disc_number: 1,
		track_number: 1,
		art_missing: true,
		favorite: false,
		duration_seconds: 1
	};
	let favorite = false,
		useLastFm = false;
	const read: string[] = [];
	await context.route(server + artistPath, (route) =>
		route.fulfill({ contentType: 'text/html', body: '<title>DN artist</title>' })
	);
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url()),
			path = url.pathname.slice('/music/api/v3'.length),
			json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (path === '/me') return json({ id: 'guest', role: 'user', display_name: 'Guest' });
		if (path === '/home') return json({ sections: [] });
		if (path === '/me/section-prefs') return json({ pages: {} });
		if (path === '/library/albums') return json({ items: [], total: 0 });
		if (path === '/library/artists')
			return json({
				items: [
					{
						id: artistId,
						name: 'Guest Artist',
						album_count: 1,
						track_count: 1,
						artist_mbid: '64b535c0-2ab8-4051-83e7-06856fda2a45',
						favorite
					}
				],
				total: 1
			});
		if (path === artistPath + '/albums') {
			read.push('albums');
			return json({ items: [release('solo', 'Solo sessions', 'Guest Artist')], total: 1 });
		}
		if (path === artistPath + '/appearances') {
			const after = url.searchParams.get('after');
			read.push(after ? 'later appearances' : 'appearances');
			return json(
				after
					? { items: [release('compilation', 'Night Cohort', 'Various Artists')], total: 2 }
					: { items: [release('pair', 'Night Duo', 'Night Duo')], total: 2, next: 'second-page' }
			);
		}
		if (path === '/library/albums/match/compilation') return json({ items: [song], total: 1 });
		if (path === '/favorites/artist/' + encodeURIComponent(artistId)) {
			expect(req.postDataJSON()).toEqual({ favorited: true });
			favorite = true;
			return json({ favorited: favorite });
		}
		if (path.endsWith('/top-songs')) {
			expect(url.searchParams.get('source')).toBe('listenbrainz');
			expect(url.searchParams.get('count')).toBe('50');
			return json({
				source: useLastFm ? 'lastfm' : 'listenbrainz',
				songs: [{ recording_mbid: 'second', listen_count: 900 }]
			});
		}
		if (path === '/library/tracks' && url.searchParams.has('artist_id')) {
			expect(url.searchParams.get('artist_id')).toBe(artistId);
			read.push('songs');
			const second = { ...song, id: 'encore', title: 'Encore', recording_mbid: 'second' };
			if (url.searchParams.get('after')) return json({ items: [second], total: 2 });
			return json({ items: [song], total: 2, next: 'next' });
		}
		if (path === '/stream/local/guest-song' || path === '/stream/local/encore')
			return route.fulfill({
				path: fileURLToPath(
					new URL('../../server/tests/fixtures/library/management_full.wav', import.meta.url)
				),
				contentType: 'audio/wav'
			});
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected DN endpoint ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username', { exact: true }).fill('guest');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Artists', exact: true }).click();
	await page.setViewportSize({ width: 320, height: 700 });
	await page.getByRole('button', { name: 'Guest Artist', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Solo sessions Guest Artist' })).toBeVisible();
	expect(read).toEqual(['albums']);
	await page.getByRole('button', { name: 'Favorite artist', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Remove artist from favorites' })).toBeVisible();
	const artistMenu = page.getByRole('button', { name: 'More artist actions', exact: true });
	await expect(page.getByRole('button', { name: 'Pin artist page to Home' })).toHaveCount(0);
	await artistMenu.click();
	const sheet = page.getByRole('dialog', { name: 'Artist actions' });
	await expect(sheet.getByRole('button', { name: 'Artist profile', exact: true })).toBeVisible();
	await sheet.getByRole('button', { name: 'Pin artist page to Home', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	await artistMenu.click();
	await expect(sheet.getByRole('button', { name: 'Unpin artist page from Home' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(sheet.getByRole('button', { name: 'Pin artist radio to Home' })).toHaveAttribute(
		'aria-pressed',
		'false'
	);
	await page.keyboard.press('Escape');
	await expect(artistMenu).toBeFocused();
	const header = page.locator('[data-part=local-artist-detail] [data-detail-header]');
	await expect(header.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
	const primary = (await header
		.getByRole('button', { name: 'Play artist', exact: true })
		.boundingBox())!;
	const favoriteButton = (await header
		.getByRole('button', { name: 'Remove artist from favorites' })
		.boundingBox())!;
	const overflow = (await artistMenu.boundingBox())!;
	expect(Math.abs(primary.y - favoriteButton.y)).toBeLessThan(3);
	expect(Math.abs(primary.y - overflow.y)).toBeLessThan(3);
	expect(overflow.x).toBeGreaterThan(favoriteButton.x);
	expect((await header.boundingBox())!.height).toBeLessThan(125);
	await page.getByRole('button', { name: 'Play artist', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'After Hours', exact: true })).toBeVisible();
	await minimizePlayer(page);
	const view = page.getByLabel('Artist library view');
	await chooseOption(view, 'appearances');
	await page
		.locator('[data-selectable]:visible')
		.filter({ hasText: 'Night Duo' })
		.first()
		.press('Shift+Space');
	// The compact header can bring the next-page trigger into view automatically.
	const more = page.getByRole('button', { name: 'More appearances', exact: true });
	if (await more.isVisible()) await more.click();
	await expect(page.getByRole('button', { name: 'Select Night Cohort' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Select Night Duo' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await page.getByRole('button', { name: 'Select loaded' }).click();
	await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
	const dismissed = await page.evaluate(
		() => !window.dispatchEvent(new CustomEvent('dn-back', { cancelable: true }))
	);
	expect(dismissed).toBe(true);
	await expect(page.getByRole('group', { name: 'Selection actions' })).toHaveCount(0);
	await expect(view).toBeVisible();
	await page.getByRole('button', { name: 'Night Cohort Various Artists' }).click();
	await expect(page.getByRole('heading', { name: 'Night Cohort', exact: true })).toBeVisible();
	await page
		.locator('[data-selectable]:visible')
		.filter({ hasText: 'After Hours' })
		.first()
		.press('Shift+Space');
	await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(view).toHaveAttribute('data-value', 'appearances');
	await expect(page.getByRole('button', { name: 'Night Duo Night Duo' })).toBeVisible();
	await chooseOption(view, 'songs');
	const sort = page.getByRole('combobox', { name: 'Sort songs' }),
		titles = page.locator('[data-part=track-list] .row strong');
	await chooseOption(sort, 'popularity');
	await expect(titles).toHaveText(['Encore', 'After Hours']);
	useLastFm = true;
	await chooseOption(sort, '');
	await chooseOption(sort, 'popularity');
	await expect(titles).toHaveText(['After Hours', 'Encore']);
	await expect(
		page.getByText('No ListenBrainz ranks available. Showing songs by title.')
	).toBeVisible();
	await page.getByRole('button', { name: 'Play After Hours', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'After Hours', exact: true })).toBeVisible();
	await minimizePlayer(page);
	await expect(view).toHaveAttribute('data-value', 'songs');
	expect(read).toContain('later appearances');
	await artistMenu.click();
	const popup = page.waitForEvent('popup');
	await page.getByRole('link', { name: 'Open artist in web app' }).click();
	const browser = await popup;
	await expect(browser).toHaveURL(server + artistPath);
	await browser.close();
	await page.getByRole('button', { name: 'Back to artists' }).click();
	await expect(page.getByRole('heading', { name: 'Artists', exact: true })).toBeVisible();
});
