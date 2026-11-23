import { silentWav } from './fixtures/silentWav';
import { chooseOption } from './fixtures/inlineChoice';
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';

const server = 'https://artwork.example/dn';
const file = fileURLToPath(new URL('../src/lib/player/tidal-memory.webp', import.meta.url));
const path = '/library/albums/night/artwork';
const cover = (page: Page) => page.locator('[data-widget=library-recently-added] img').first();
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function options(page: Page) {
	await button(page, 'Settings').click();
	await button(page, 'Device storage').click();
	await expect(page.getByLabel('Artwork cache limit')).toBeEnabled();
}
async function fixture(page: Page, gate?: Promise<void>) {
	let user = 'listener',
		enabled = true;
	const fetched: string[] = [];
	await page.route(server + '/api/v3/**', async (r) => {
		const req = r.request(),
			slug = new URL(req.url()).pathname.slice('/dn/api/v3'.length);
		if (slug === '/auth/providers') return r.fulfill({ json: { local: true, oidc: false } });
		if (slug === '/auth/login') {
			user = req.postDataJSON().username;
			return r.fulfill({ json: { token: 'fixture-' + user } });
		}
		expect(req.headers().authorization).toBe('Bearer fixture-' + user);
		if (slug === '/me')
			return r.fulfill({
				json: { id: user, display_name: 'Listener', role: 'user' }
			});
		if (slug === '/library/albums')
			return r.fulfill({
				json: {
					items: [
						{
							id: 'night',
							title: 'Night train',
							artist_name: 'Harbour',
							release_group_mbid: '11111111-1111-4111-8111-111111111111',
							cover_available: true
						}
					],
					next: null,
					total: 1
				}
			});
		if (slug === path) {
			fetched.push(user);
			if (gate) await gate;
			return enabled
				? r.fulfill({ path: file, contentType: 'image/webp' })
				: r.fulfill({ status: 503 });
		}
		if (await emptyBoardRead(r)) return;
		return r.fulfill({ status: 404 });
	});
	return {
		fetched,
		rejectArtwork: () => {
			enabled = false;
		}
	};
}

test('viewed covers survive a relaunch, work without an art server and stay private to each account', async ({
	page
}) => {
	const env = await fixture(page);
	await localSignIn(page, server);
	await expect(cover(page)).toBeVisible();
	await expect
		.poll(() => cover(page).evaluate((el) => (el as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	await options(page);
	const storage = page.getByRole('group', { name: 'Cover artwork' });
	await expect(storage).toContainText(/1\s+cover\s*·/);
	expect(env.fetched).toEqual(['listener']);
	env.rejectArtwork();
	await localSignIn(page, server, 'second');
	await expect.poll(() => env.fetched).toEqual(['listener', 'second']);
	await options(page);
	await expect(storage).toContainText(/0\s+covers\s*·/);
	await localSignIn(page, server);
	await expect(cover(page)).toBeVisible();
	await page.context().setOffline(true);
	await options(page);
	await expect(storage).toContainText(/1\s+cover\s*·/);
	await button(page, 'Clear artwork cache').click();
	await storage.getByRole('button', { name: 'Cancel' }).click();
	await expect(storage).toContainText(/1\s+cover\s*·/);
	await button(page, 'Clear artwork cache').click();
	await button(page, 'Remove cached covers').click();
	await expect(storage).toContainText(/0\s+covers\s*·/);
	expect(env.fetched).toEqual(['listener', 'second']);
});

test('turning off artwork caching prevents an older request from refilling it', async ({
	page
}) => {
	let release!: () => void;
	const env = await fixture(
		page,
		new Promise<void>((resolve) => {
			release = resolve;
		})
	);
	await localSignIn(page, server);
	await expect.poll(() => env.fetched.length).toBe(1);
	await options(page);
	await chooseOption(page.getByLabel('Artwork cache limit'), '0');
	await expect(page.getByLabel('Artwork cache limit')).toBeEnabled();
	const received = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith(path));
	release();
	await received;
	await button(page, 'Back').click();
	await button(page, 'Back').click();
	await expect(cover(page)).toBeVisible();
	await options(page);
	await expect(page.getByLabel('Artwork cache limit')).toHaveAttribute('data-value', '0');
	await expect(page.getByRole('group', { name: 'Cover artwork' })).toContainText(/0\s+covers\s*·/);
});

test('album artwork colors can follow the player or entire app and revert for missing covers', async ({
	page
}) => {
	const { fetched } = await fixture(page);
	await page.route(server + '/api/v3/library/albums/match/night*', (route) =>
		route.fulfill({
			json: {
				items: [
					{ id: 'side-a', title: 'Night ride', cover_available: true },
					{ id: 'side-b', title: 'Morning ride', art_missing: true }
				].map((track, index) => ({
					...track,
					album_id: 'night',
					release_group_mbid: '11111111-1111-4111-8111-111111111111',
					album_title: 'Night train',
					artist_name: 'Harbour',
					disc_number: 1,
					track_number: index + 1,
					duration_seconds: 60
				})),
				total: 2
			}
		})
	);
	const audio = silentWav();
	await page.route(server + '/api/v3/stream/local/**', (route) =>
		route.fulfill({ body: audio, contentType: 'audio/wav' })
	);
	const themes = async () => {
		await button(page, 'Settings').click();
		await button(page, 'Themes').click();
	};
	const root = page.locator('html');
	const scope = page.getByRole('combobox', { name: 'Album artwork colors' });
	const background = () =>
		root.evaluate((el) => getComputedStyle(el).getPropertyValue('--bg').trim());
	await localSignIn(page, server);
	const base = await background();
	await themes();
	await expect(scope).toHaveAttribute('data-value', 'off');
	await chooseOption(scope, 'player');
	await button(page, 'Back').click();
	await button(page, 'Back').click();
	await page
		.getByRole('button', { name: /Night train Harbour/i })
		.first()
		.click();
	await button(page, 'Play album').click();
	const player = page.locator('[data-part="now-playing"]');
	await expect(player.getByRole('heading', { name: 'Night ride' })).toBeVisible();
	await expect.poll(background).not.toBe(base);
	const artwork = await background();
	await player.getByRole('button', { name: 'More actions', exact: true }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Close player', exact: true }).click();
	await expect(root).toHaveCSS('--bg', base);
	await themes();
	const requests = fetched.length;
	await chooseOption(scope, 'app');
	await expect(root).toHaveCSS('--bg', artwork);
	expect(fetched.length).toBe(requests);
	await chooseOption(scope, 'off');
	await expect(root).toHaveCSS('--bg', base);
	await chooseOption(scope, 'app');
	await button(page, 'Back').click();
	await button(page, 'Back').click();
	await button(page, 'Open player for Night ride').click();
	await expect(root).toHaveCSS('--bg', artwork);
	await player.getByRole('button', { name: 'Next track' }).click();
	await expect(player.getByRole('heading', { name: 'Morning ride' })).toBeVisible();
	await expect(root).toHaveCSS('--bg', base);
	await page.reload();
	await themes();
	await expect(scope).toHaveAttribute('data-value', 'app');
});

test('artist portraits retry while warming and use local artwork when DN has no photo', async ({
	page
}) => {
	await fixture(page);
	const people = ['Warming', 'Missing'];
	await page.route(server + '/api/v3/library/artists?*', (route) =>
		route.fulfill({
			json: {
				items: people.map((name, i) => ({
					name,
					id: 'local' + i,
					artist_mbid: 'mbid' + i,
					album_count: 1
				})),
				total: 2
			}
		})
	);
	let warm = 0;
	await page.route(server + '/api/v3/covers/artist/mbid0?*', (route) =>
		++warm === 1
			? route.fulfill({ status: 202 })
			: route.fulfill({ path: file, contentType: 'image/webp' })
	);
	await page.route(server + '/api/v3/covers/artist/mbid1?*', (route) =>
		route.fulfill({ status: 404 })
	);
	let mosaic = 0;
	await page.route(server + '/api/v3/library/artists/local1/artwork?*', (route) => {
		mosaic++;
		return route.fulfill({ path: file, contentType: 'image/webp' });
	});
	await localSignIn(page, server);
	await button(page, 'Library').click();
	await button(page, 'Browse Artists').click();
	await expect(page.locator('[data-part=category-items] img')).toHaveCount(2);
	expect(warm).toBe(2);
	expect(mosaic).toBe(1);
});

test('manual artist sync follows pages, stores fallback images, respects offline mode and allows 4 GiB', async ({
	page
}) => {
	await fixture(page);
	const pages: string[] = [];
	await page.route(server + '/api/v3/library/artists?*', (route) => {
		const after = new URL(route.request().url()).searchParams.get('after');
		pages.push(after ?? '');
		return route.fulfill({
			json: {
				items: [
					after
						? { id: 'local2', name: 'Second', artist_mbid: 'mbid2' }
						: { id: 'local1', name: 'First', artist_mbid: 'mbid1' }
				],
				total: 2,
				next: after ? null : 'next'
			}
		});
	});
	await page.route(server + '/api/v3/covers/artist/mbid1?*', (route) =>
		route.fulfill({ path: file, contentType: 'image/webp' })
	);
	await page.route(server + '/api/v3/covers/artist/mbid2?*', (route) =>
		route.fulfill({ status: 404 })
	);
	await page.route(server + '/api/v3/library/artists/local2/artwork?*', (route) =>
		route.fulfill({ path: file, contentType: 'image/webp' })
	);
	await localSignIn(page, server);
	await options(page);
	await chooseOption(page.getByLabel('Artwork cache limit'), '4096');
	await expect(page.getByLabel('Artwork cache limit')).toHaveText(/4 GiB/);
	const count = pages.length;
	await button(page, 'Sync artist artwork').click();
	await expect(page.getByRole('status')).toContainText('Checked 2 artists. Updated 2 images.');
	expect(pages.slice(count)).toEqual(['', 'next']);
	await page.context().setOffline(true);
	await button(page, 'Sync artist artwork').click();
	await expect(page.getByRole('alert')).toContainText('turn off offline mode');
	expect(pages.slice(count)).toEqual(['', 'next']);
});

test('stopping an artist sync keeps the cache and stops further artist requests', async ({
	page
}) => {
	await fixture(page);
	await localSignIn(page, server);
	await options(page);
	await page.route(server + '/api/v3/library/artists?*', (route) =>
		route.fulfill({
			json: {
				items: [
					{ id: 'one', artist_mbid: 'first' },
					{ id: 'two', artist_mbid: 'second' }
				],
				total: 2
			}
		})
	);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const ids: string[] = [];
	await page.route(server + '/api/v3/covers/artist/**', async (route) => {
		ids.push(new URL(route.request().url()).pathname.split('/').at(-1)!);
		await gate;
		await route.fulfill({ path: file, contentType: 'image/webp' }).catch(() => {});
	});
	await button(page, 'Sync artist artwork').click();
	await expect.poll(() => ids).toEqual(['first']);
	await button(page, 'Stop artwork sync').click();
	await expect(page.getByRole('status')).toContainText('Sync stopped.');
	release();
	expect(ids).toEqual(['first']);
});
