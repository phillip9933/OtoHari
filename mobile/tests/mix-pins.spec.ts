import { minimizePlayer } from './fixtures/minimizePlayer';
import { expect, test } from '@playwright/test';
import { localSignIn } from './fixtures/localSignIn';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { chooseOption } from './fixtures/inlineChoice';
import { seedOfflineMusic } from './fixtures/offlineMusic';
import { silentWav } from './fixtures/silentWav';

const server = 'https://mix.example/music';
const first = '11111111-1111-4111-a111-111111111111';
const second = '22222222-2222-4222-a222-222222222222';

test('a saved artist mix and a station can be pinned, reordered and used after reopening Home', async ({
	page
}) => {
	const plans: unknown[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url());
		const path = url.pathname.split('/api/v3/')[1];
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === 'auth/providers')
			return json({ local: true, oidc: false, plex: false, jellyfin: false });
		if (path === 'auth/login') return json({ token: 'fixture' });
		if (path === 'me') return json({ id: 'listener', display_name: 'Listener' });
		if (path === 'stream/local/one-track')
			return route.fulfill({ contentType: 'audio/wav', body: silentWav(10) });
		if (path === 'artists/' + first + '/owned-releases')
			return json({
				items: [{ id: second, primary_type: 'EP', secondary_types: [] }],
				complete: true
			});
		if (path === 'library/artists/one/albums') {
			const later = url.searchParams.get('after') === 'next-page';
			return json({
				items: [
					{
						id: later ? 'ep' : 'unlinked',
						title: later ? 'Owned EP' : 'Unclassified recording',
						artist_name: 'Aurora',
						release_group_mbid: later ? second : null
					}
				],
				next: later ? null : 'next-page',
				total: 2
			});
		}
		if (path === 'library/artists')
			return json({
				items: [
					{ id: 'one', name: 'Aurora', artist_mbid: first, album_count: 2, favorite: false },
					{ id: 'two', name: 'Aurelia', artist_mbid: second, album_count: 1, favorite: false }
				],
				total: 2
			});
		if (path === 'discover/radio/plan') {
			plans.push(req.postDataJSON());
			return json({
				title: 'Mix',
				tracks: [
					{
						artist_name: 'Aurora',
						track_name: 'Cold skies',
						in_library: true,
						local_file_id: 'one-track'
					}
				]
			});
		}
		if (path === 'artists/' + first + '/releases') {
			const item = (id: string, title: string) => ({
				id,
				title,
				in_library: true,
				requested: false
			});
			return json(
				url.searchParams.get('offset') === '0'
					? {
							albums: [item(first, 'First full length')],
							eps: [],
							singles: [],
							has_more: true,
							next_offset: 24
						}
					: { albums: [], eps: [item(second, 'Northern EP')], singles: [], has_more: false }
			);
		}
		if (path.endsWith('/follow-status')) return json({ followed: false });
		if (await emptyBoardRead(route)) return;
		return route.fulfill({ status: 404, json: {} });
	});
	await localSignIn(page, server);
	await page.getByRole('button', { name: 'Discover', exact: true }).click();
	await page.getByRole('button', { name: 'Mix Builder', exact: true }).click();
	const mix = page.getByRole('dialog', { name: 'Mix Builder' });
	await mix.getByLabel('Find artists').fill('Aur');
	await mix.getByRole('button', { name: 'Add Aurora', exact: true }).click();
	await mix.getByRole('button', { name: 'Add Aurelia', exact: true }).click();
	await mix.getByLabel('Mix name').fill('Northern lights');
	await mix.getByRole('button', { name: 'Save mix', exact: true }).click();
	await mix.getByRole('button', { name: 'Pin to Home', exact: true }).click();
	await mix.getByRole('button', { name: 'Close', exact: true }).click();

	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Artists', exact: true }).click();
	await page.getByRole('button', { name: 'Aurora', exact: false }).first().click();
	await chooseOption(page.getByRole('combobox', { name: 'Release type' }), 'ep');
	await expect(page.getByRole('button', { name: 'Owned EP Aurora' })).toBeVisible();
	await chooseOption(page.getByRole('combobox', { name: 'Release type' }), 'unknown');
	await expect(page.getByRole('button', { name: 'Unclassified recording Aurora' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Owned EP Aurora' })).toHaveCount(0);
	await page.getByRole('button', { name: 'More artist actions' }).click();
	await page.getByRole('button', { name: 'Artist profile', exact: true }).click();
	await chooseOption(page.getByRole('combobox', { name: 'Release type' }), 'eps');
	await expect(page.getByRole('button', { name: /Northern EP Aurora/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /First full length Aurora/ })).toHaveCount(0);
	await page.getByRole('button', { name: 'More artist actions' }).click();
	await page.getByRole('button', { name: 'Pin artist radio to Home', exact: true }).click();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	const pins = page.getByRole('region', { name: 'Pinned to Home' });
	await pins.getByRole('button', { name: 'Arrange pins' }).click();
	await pins.getByRole('button', { name: 'Move Aurora up' }).click();
	await pins.getByRole('button', { name: 'Done' }).click();
	await page.reload();
	await localSignIn(page, server);
	await expect(pins.getByRole('listitem').first()).toContainText('Aurora');
	await pins.getByRole('button', { name: 'Northern lights', exact: false }).click();
	await expect.poll(() => plans.length).toBe(1);
	expect(plans[0]).toMatchObject({
		seed_type: 'items',
		mode: 'library',
		items: [
			{ artist_mbid: first, artist_name: 'Aurora' },
			{ artist_mbid: second, artist_name: 'Aurelia' }
		]
	});
	await minimizePlayer(page);
	await seedOfflineMusic(page, server, 'listener', true, [
		{
			origin: 'downloaded',
			track: {
				id: 'one-track',
				title: 'Cold skies (saved)',
				artist: 'Aurora',
				album: '',
				streamUrl: server + '/api/v3/stream/local/one-track'
			}
		}
	]);
	await expect(page.getByText('Music on this device', { exact: true })).toBeVisible();
	await pins.getByRole('button', { name: 'Northern lights', exact: false }).click();
	await expect(
		page.getByRole('heading', { name: 'Cold skies (saved)', exact: true })
	).toBeVisible();
	expect(plans).toHaveLength(1);
});

test('album mixes use release-group seeds and each listener has a separate set of Home pins', async ({
	page
}) => {
	let user = 'first-listener',
		planned: unknown;
	await page.route(server + '/api/v3/**', async (route) => {
		const url = new URL(route.request().url()),
			path = url.pathname.split('/api/v3/')[1];
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === 'auth/providers') return json({ local: true, oidc: false });
		if (path === 'auth/login') return json({ token: 'fixture' });
		if (path === 'me') return json({ id: user, display_name: 'Listener' });
		if (path === 'library/albums' && url.searchParams.has('q'))
			return json({
				items: [
					{
						id: 'one',
						title: 'Azure EP',
						artist_name: 'Aurora',
						artist_mbid: first,
						release_group_mbid: second
					},
					{ id: 'two', title: 'Unlinked album', artist_name: 'Aurora' }
				],
				total: 2
			});
		if (path === 'library/tracks')
			return json({
				items: [
					{
						id: 'sun',
						title: 'Morning sun',
						artist_name: 'Aurora',
						album_title: 'Azure EP',
						duration_seconds: 4,
						format: 'FLAC',
						artist_mbid: first
					}
				],
				total: 1
			});
		if (path === 'discover/radio/plan') {
			planned = route.request().postDataJSON();
			return json({ tracks: [] });
		}
		if (await emptyBoardRead(route)) return;
		return route.fulfill({ status: 404, json: {} });
	});
	await localSignIn(page, server);
	const b = (name: string) => page.getByRole('button', { name, exact: true });
	await b('Discover').click();
	await b('Mix Builder').click();
	const modal = page.getByRole('dialog', { name: 'Mix Builder' });
	await chooseOption(modal.getByRole('combobox', { name: 'Build from' }), 'albums');
	await modal.getByLabel('Find albums').fill('azu');
	await b('Add Azure EP').click();
	await expect(b('Add Unlinked album')).toHaveCount(0);
	await b('Play mix').click();
	await expect(modal.getByText('No playable tracks for these selections.')).toBeVisible();
	expect(planned).toMatchObject({
		mode: 'library',
		seed_type: 'items',
		items: [
			{ artist_mbid: first, artist_name: 'Aurora', album_mbid: second, album_name: 'Azure EP' }
		]
	});
	await b('Close').click();
	await b('Library').click();
	await b('Browse Tracks').click();
	await b('More options for Morning sun').click();
	await b('Pin to Home').click();
	await b('Home').click();
	const pins = page.getByRole('region', { name: 'Pinned to Home' });
	await expect(pins.getByRole('listitem')).toHaveCount(1);
	await expect(pins.getByText('Morning sun')).toBeVisible();
	user = 'second-listener';
	await localSignIn(page, server);
	await expect(pins).toHaveCount(0);
	user = 'first-listener';
	await localSignIn(page, server);
	await expect(pins.getByText('Morning sun')).toBeVisible();
	await pins.getByRole('button', { name: 'Arrange pins' }).click();
	await pins.getByRole('button', { name: 'Unpin Morning sun' }).click();
	await expect(pins).toHaveCount(0);
});
