import { chooseOption } from './fixtures/inlineChoice';
import { expect, test, type Page } from '@playwright/test';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { silentWav } from './fixtures/silentWav';

const server = 'https://credits.example/dn',
	user = 'listener',
	scope = JSON.stringify([server, user]),
	artistId = 'artist-one',
	albumId = 'album-two';
const wav = silentWav();
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const track = (i: number) => ({
	id: 'song-' + i,
	title: 'Track ' + i,
	artist_name: 'Guest artist',
	artist_id: artistId,
	album_artist_name: 'Various Artists',
	album_artist_id: 'compilation-artist',
	album_title: 'Shared title',
	album_id: albumId,
	art_missing: true,
	duration_seconds: 60,
	disc_number: 1,
	track_number: i + 1
});
const tracks = Array.from({ length: 36 }, (_, i) => track(i));
async function fixture(page: Page, group = false) {
	await page.addInitScript(
		({ server, user, group }) => {
			const credits = group ? ['player-track'] : ['player-title', 'player-artist', 'player-album'];
			const ids = ['player-close', ...credits, 'player-transport'];
			localStorage.setItem(
				'dn.mobile.layout.v1.' + JSON.stringify([server, user, 'player']),
				JSON.stringify(ids.map((id) => ({ id, preview: true, title: '' })))
			);
		},
		{ server, user, group }
	);
	const reads: string[] = [],
		audio: string[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const path = new URL(route.request().url()).pathname.split('/api/v3')[1];
		const json = (value: unknown) => route.fulfill({ json: value });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		expect(route.request().headers().authorization).toBe('Bearer fixture');
		reads.push(path);
		if (path === '/me') return json({ id: user, role: 'user', display_name: user });
		if (path === '/library/tracks')
			return json({ items: tracks, total: tracks.length, next: null });
		if (path === '/library/stats') return json({ format_breakdown: {} });
		if (path === '/library/albums/' + albumId)
			return json({
				id: albumId,
				title: 'Shared title',
				artist_name: 'Various Artists',
				art_missing: true
			});
		if (path === '/library/albums/match/' + albumId) return json({ items: [track(9)], total: 1 });
		if (path === '/library/artists/' + artistId)
			return json({ id: artistId, name: 'Guest artist', favorite: false, album_count: 1 });
		if (path === '/library/artists/' + artistId + '/albums')
			return json({
				items: [
					{ id: albumId, title: 'Shared title', artist_name: 'Various Artists', art_missing: true }
				],
				total: 1,
				next: null
			});
		if (path.startsWith('/stream/local/')) {
			audio.push(path);
			return route.fulfill({ body: wav, contentType: 'audio/wav' });
		}
		if (path === '/ratings/lookup') return json({ tracks: {}, albums: {}, artists: {} });
		if (path.endsWith('/lyrics')) return json({ lines: [] });
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected request ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await button(page, 'Continue').click();
	await page.getByLabel('Username').fill(user);
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await button(page, 'Sign in').click();
	await button(page, 'Library').click();
	await button(page, 'Browse Tracks').click();
	await expect(button(page, 'Play Track 0')).toBeVisible();
	return { reads, audio };
}

for (const group of [false, true])
	test(
		(group ? 'Grouped' : 'Independent') +
			' player credits open exact DN IDs and preserve audio, focus and the library return position',
		async ({ page }) => {
			const { reads, audio } = await fixture(page, group);
			const main = page.locator('main');
			const original = await button(page, 'Play Track 9').evaluate((el) => {
				const main = el.closest('main')!;
				main.scrollTop += el.getBoundingClientRect().top - 240;
				return main.scrollTop;
			});
			expect(original).toBeGreaterThan(100);
			await button(page, 'Play Track 9').click();
			const album = button(page, 'Open album Shared title'),
				artist = button(page, 'Open artist Guest artist');
			await expect(album).toBeVisible();
			await album.focus();
			await page.keyboard.press('Enter');
			await expect(
				page.locator('[data-part=album-detail]').getByRole('heading', { name: 'Shared title' })
			).toBeVisible();
			await expect(button(page, 'Back to Now Playing')).toBeVisible();
			await expect(page.getByRole('region', { name: 'Current track' })).toBeVisible();
			await expect(page.getByRole('navigation', { name: 'Music' })).toBeVisible();
			await expect(page.getByRole('region', { name: 'Now playing' })).toHaveCount(0);
			await button(page, 'Back to Now Playing').click();
			await expect(album).toBeFocused();
			await artist.tap();
			await expect(
				page
					.locator('[data-part=local-artist-detail]')
					.getByRole('heading', { name: 'Guest artist' })
			).toBeVisible();
			await expect
				.poll(() => reads.includes('/library/artists/' + artistId + '/albums'))
				.toBe(true);
			await button(page, 'Shared title Various Artists').click();
			await expect(page.locator('[data-part=album-detail] h1')).toHaveText('Shared title');
			await button(page, 'Back').click();
			await expect(page.locator('[data-part=local-artist-detail] h1')).toHaveText('Guest artist');
			await page.keyboard.press('Escape');
			await expect(artist).toBeFocused();
			await expect(button(page, 'Pause')).toBeVisible();
			expect(audio).toEqual(['/stream/local/song-9']);
			expect(reads).toContain('/library/albums/' + albumId);
			expect(reads).not.toContain('/library/artists/compilation-artist');
			await button(page, 'Close player').click();
			await expect(button(page, 'Play Track 9')).toBeFocused();
			await expect
				.poll(() => main.evaluate((el, offset) => Math.abs(el.scrollTop - offset), original))
				.toBeLessThan(2);
		}
	);

async function seedDevice(page: Page, ambiguous: boolean) {
	const data = Array.from(silentWav(8));
	await page.evaluate(
		async ({ scope, data, ambiguous }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const req = indexedDB.open('dn.mobile.offline.v1', 1);
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
			const tx = db.transaction('tracks', 'readwrite'),
				s = tx.objectStore('tracks');
			const audio = new Blob([new Uint8Array(data)], { type: 'audio/wav' });
			const rows = [
				{
					id: 'song-9',
					title: 'Track 9',
					origin: 'downloaded',
					album: 'Shared title',
					artist: 'Guest artist',
					albumArtist: 'Various Artists',
					albumId: 'album-two',
					artistId: 'artist-one'
				},
				{ id: 'legacy', title: 'Saved opener', origin: 'downloaded' },
				{ id: 'sibling', title: 'Saved neighbor', origin: 'downloaded' },
				{ id: 'cache', title: 'Cached elsewhere', origin: 'cached' },
				...(ambiguous
					? [
							{
								id: 'other',
								title: 'Different edition',
								origin: 'downloaded',
								albumId: 'other-album',
								artistId: 'other-artist'
							}
						]
					: [])
			];
			for (const row of rows) {
				const track = {
					album: 'Old record',
					artist: 'Old artist',
					...row,
					streamUrl: '/api/v3/stream/local/' + row.id
				};
				s.put({
					id: row.id,
					scope,
					track,
					used: 1,
					bytes: audio.size,
					audio,
					pinned: row.origin === 'downloaded',
					origin: row.origin
				});
			}
			await new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
			window.dispatchEvent(new Event('dn-offline-media'));
		},
		{ scope, data, ambiguous }
	);
}

for (const ambiguous of [false, true])
	test(
		'saved-only legacy credits ' +
			(ambiguous ? 'explain ambiguity' : 'stay inside downloaded groups') +
			' without contacting DN',
		async ({ page }) => {
			const { reads, audio } = await fixture(page);
			await seedDevice(page, ambiguous);
			await button(page, 'Collection filters').click();
			await chooseOption(page.getByLabel('Availability', { exact: true }), 'offline');
			await button(page, 'Play Saved opener').click();
			await expect(button(page, 'Open album Old record')).toBeVisible();
			const before = reads.filter((p) => p.startsWith('/library/'));
			for (const [kind, name] of [
				['album', 'Old record'],
				['artist', 'Old artist']
			]) {
				const entry = button(page, 'Open ' + kind + ' ' + name);
				await entry.click();
				if (ambiguous)
					await expect(
						page.getByText('This track has no available ' + kind + ' link in this library.')
					).toBeVisible();
				else {
					await expect(page.getByText('On this device', { exact: true })).toBeVisible();
					await expect(button(page, 'Play Saved neighbor')).toBeVisible();
					await expect(button(page, 'Play Cached elsewhere')).toBeVisible();
				}
				await page.keyboard.press('Escape');
				await expect(entry).toBeFocused();
			}
			expect(reads.filter((p) => p.startsWith('/library/'))).toEqual(before);
			expect(audio).toHaveLength(0);
		}
	);

test('turning on offline-only while a track plays opens its saved copy by ID even on an active network', async ({
	page
}) => {
	const { reads } = await fixture(page);
	await seedDevice(page, false);
	await button(page, 'Play Track 9').click();
	await page.evaluate(async (scope) => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('dn.mobile.offline.v1');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		const tx = db.transaction('options', 'readwrite');
		tx.objectStore('options').put({ offlineOnly: true }, scope);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
		window.dispatchEvent(new Event('dn-offline-policy'));
	}, scope);
	const count = reads.filter((p) => p.startsWith('/library/')).length;
	await button(page, 'Open album Shared title').click();
	await expect(page.getByText('On this device', { exact: true })).toBeVisible();
	await expect(button(page, 'Play Track 9')).toBeVisible();
	expect(reads.filter((p) => p.startsWith('/library/'))).toHaveLength(count);
	await button(page, 'Back to Now Playing').click();
	await expect(button(page, 'Open album Shared title')).toBeFocused();
});
