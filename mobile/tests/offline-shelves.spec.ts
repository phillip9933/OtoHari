import { minimizePlayer } from './fixtures/minimizePlayer';
import { test, expect, type Page } from '@playwright/test';
import { localSignIn } from './fixtures/localSignIn';
import { seedOfflineMusic } from './fixtures/offlineMusic';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import type { OfflineOrigin } from '../src/lib/offline/tracks';

const server = 'https://shelf-library.example';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const songs = ['Glow', 'Night', 'Bird', 'Signal'].map((title, index) => ({
	origin: (['cached', 'downloaded', 'automatic', 'downloaded'] as OfflineOrigin[])[index],
	track: {
		id: 't' + index,
		title,
		artist: index < 2 ? 'Mica' : 'Jun',
		album: index < 2 ? 'Neon' : index === 2 ? 'Island' : 'Untimed',
		albumId: index < 2 ? 'neon' : index === 2 ? 'island' : 'untimed',
		artistId: index < 2 ? 'mica' : 'jun',
		genre: index < 2 ? 'Jazz' : 'Folk',
		dateAdded: [100, 150, 200, undefined][index],
		year: 2020,
		trackNumber: index + 1,
		rating: index === 2 ? 4 : 5,
		format: 'flac',
		favorite: index < 2,
		artworkUrl: '/api/v3/library/albums/art/artwork',
		streamUrl: '/api/v3/stream/local/t' + index
	}
}));
const serverSongs = songs.map(({ track: t }) => ({
	id: t.id,
	title: t.title,
	artist_name: t.artist,
	artist_id: t.artistId,
	album_title: t.album,
	album_id: t.albumId,
	genre: t.genre,
	duration_secs: 60,
	format: 'flac'
}));
async function api(page: Page) {
	let deny = false;
	const requests: URL[] = [],
		blocked: string[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const url = new URL(route.request().url()),
			path = url.pathname.slice(7),
			json = (data: unknown) => route.fulfill({ json: data });
		requests.push(url);
		if (deny) {
			blocked.push(path);
			return route.abort();
		}
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'shelf-fixture' });
		if (path === '/me') return json({ id: 'listener', display_name: 'Listener', role: 'user' });
		const playlist = {
			id: 'set',
			name: 'Listening set',
			is_owner: true,
			can_edit: true,
			is_redacted: false,
			can_delete: true,
			track_count: 3,
			cover_urls: []
		};
		if (path === '/playlists') return json({ playlists: [playlist] });
		if (path === '/playlists/set')
			return json({
				...playlist,
				tracks: ['t2', 'not-saved', 't0'].map((id, i) => ({
					id: 'e' + i,
					track_name: id === 't2' ? 'Bird' : id === 't0' ? 'Glow' : 'Online song',
					source_type: 'local',
					library_file_id: id,
					track_source_id: id
				}))
			});
		if (path === '/library/stats')
			return json({ total_tracks: songs.length, last_scan_at: '2026-01-01' });
		if (path === '/library/tracks') {
			const g = url.searchParams.get('genre');
			const items = g ? serverSongs.filter((t) => t.genre === g) : serverSongs;
			return json({ items, total: items.length, next: null });
		}
		if (path === '/library/albums' && url.searchParams.get('favorites') === 'true')
			return json({
				items: [{ id: 'island', title: 'Island', artist_name: 'Jun', art_missing: true }],
				total: 1,
				next: null
			});
		if (await emptyBoardRead(route)) return;
		return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
	});
	return { requests, blocked, setOffline: (v: boolean) => (deny = v) };
}
const rule = {
	kind: 'songs',
	query: '',
	favorites: false,
	sort: 'title',
	rating: 5,
	ratingMode: 'at_least',
	formats: [],
	formatMode: 'with'
};
test('offline custom shelves honor exact geometry and membership, play local music and stay in the collection on reconnect', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 780 });
	const network = await api(page);
	await page.addInitScript(
		({ server, rule }) => {
			const key = JSON.stringify([server, 'listener']),
				favorite = {
					...rule,
					id: 'library-filter-favorites',
					name: 'Favorite albums',
					kind: 'albums',
					sort: 'name',
					favorites: true,
					rating: 0
				},
				five = { ...rule, id: 'library-filter-five', name: 'Five stars' };
			const display = { layout: 'grid', columns: 3, listColumns: 2, rows: 1, density: 'compact' };
			const home = [
				favorite.id,
				'library-albums',
				'library-artists',
				'library-tracks',
				'library-playlists',
				'library-genres',
				five.id,
				'library-recently-added',
				'library-recently-played',
				'discover-top_picks'
			].map((id) => ({
				id,
				preview: true,
				title: '',
				display: { ...display, layout: id === 'library-tracks' ? 'list' : 'grid' }
			}));
			localStorage.setItem(
				'dn.mobile.boards.v2.' + key,
				JSON.stringify({
					filters: [favorite, five],
					layouts: { home, library: home.filter((r) => r.id.startsWith('library-')) }
				})
			);
			localStorage.setItem(
				'dn.mobile.smart-playlists.v1.' + key + '.smart-five',
				JSON.stringify({ ...rule, id: 'smart-five', name: 'Starred set', limit: 2, order: 'asc' })
			);
		},
		{ server, rule }
	);
	await localSignIn(page, server);
	const shelf = (name: string) => page.getByRole('region', { name, exact: true });
	await expect(shelf('Favorite albums').getByText('Island', { exact: true })).toBeVisible();
	await button(page, 'Search').click();
	await page
		.getByRole('group', { name: 'Search category' })
		.getByRole('button', { name: 'Playlists' })
		.click();
	await button(page, 'Listening set').click();
	await expect(page.getByRole('heading', { name: 'Listening set', exact: true })).toBeVisible();
	await expect(button(page, 'Play Bird')).toBeVisible();
	await button(page, 'Home').click();
	await seedOfflineMusic(page, server, 'other', true, [
		{
			...songs[0],
			track: { ...songs[0].track, id: 'other', title: 'Private song', album: 'Private album' }
		}
	]);
	await seedOfflineMusic(page, server, 'listener', true, songs);
	await expect(page.getByText('Music on this device')).toBeVisible();
	network.setOffline(true);
	const albums = shelf('Albums');
	await albums.scrollIntoViewIfNeeded();
	await expect(albums.locator('.preview-items > [data-preview-item]')).toHaveCount(3);
	await expect(albums.locator('[data-preview]')).toHaveAttribute('data-density', 'compact');
	expect(
		await albums
			.locator('.preview-items')
			.evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length)
	).toBe(3);
	const tracks = shelf('Tracks');
	await tracks.scrollIntoViewIfNeeded();
	await expect(tracks.locator('.preview-items > [data-preview-item]')).toHaveCount(2);
	expect(
		await tracks
			.locator('.preview-items')
			.evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length)
	).toBe(2);
	await expect(page.getByText('Private album')).toHaveCount(0);
	await expect(
		shelf('Favorite albums').getByRole('button', { name: 'Island', exact: true })
	).toBeVisible();
	await expect(
		shelf('Favorite albums').getByRole('button', { name: 'Neon', exact: true })
	).toHaveCount(0);
	await shelf('Artists').getByRole('button', { name: 'Mica', exact: true }).click();
	await expect(button(page, 'Play Glow')).toBeVisible();
	await expect(button(page, 'Play Bird')).toHaveCount(0);
	await page.keyboard.press('Escape');
	const recent = shelf('Recently added');
	await recent.scrollIntoViewIfNeeded();
	await expect(recent.locator('[data-preview-item] .body strong')).toHaveText(['Island', 'Neon']);
	await shelf('Library genres').scrollIntoViewIfNeeded();
	await shelf('Library genres').getByRole('button', { name: 'Jazz', exact: true }).click();
	await expect(button(page, 'Play Night')).toBeVisible();
	await expect(button(page, 'Play Bird')).toHaveCount(0);
	await button(page, 'Play Glow').click();
	await minimizePlayer(page);
	await page.keyboard.press('Escape');
	await button(page, 'Browse Five stars').click();
	const expanded = page.locator('[data-collection=expanded]');
	await expect(expanded.getByRole('button', { name: 'Play Signal' })).toBeVisible();
	await expect(expanded.getByRole('button', { name: 'Play Bird' })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await shelf('Playlists').getByRole('button', { name: 'Starred set', exact: true }).click();
	await expect(button(page, 'Play Glow')).toBeVisible();
	await expect(button(page, 'Play Signal')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await shelf('Playlists').getByRole('button', { name: 'Listening set', exact: true }).click();
	await expect(button(page, 'Play Bird')).toBeVisible();
	await expect(button(page, 'Play Night')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await shelf('Recently played').scrollIntoViewIfNeeded();
	await expect(shelf('Recently played')).toContainText(
		'Connect to DroppedNeedle to view your listening history.'
	);
	await shelf('Top picks for you').scrollIntoViewIfNeeded();
	await expect(shelf('Top picks for you')).toContainText('Connect to DroppedNeedle');
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	await shelf('Albums').getByRole('button', { name: 'Neon', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Neon', exact: true })).toBeVisible();
	expect(network.blocked).toEqual([]);
	network.setOffline(false);
	const before = network.requests.length;
	await seedOfflineMusic(page, server, 'listener', false, songs);
	await expect(button(page, 'Play Glow')).toBeVisible();
	expect(network.requests.length).toBe(before);
	await button(page, 'Back to Library').click();
	await expect(page.getByText('Music on this device')).toHaveCount(0);
	await expect(shelf('Favorite albums').getByText('Island', { exact: true })).toBeVisible();
});

test('Library genres is opt-in, reuses the local genre directory and opens the paged DN genre directly', async ({
	page,
	context
}) => {
	const network = await api(page);
	await localSignIn(page, server);
	await seedOfflineMusic(page, server, 'listener', false, [songs[0]]);
	await expect(button(page, 'Browse Library genres')).toHaveCount(0);
	await button(page, 'Library').click();
	await button(page, 'Library sections').click();
	await expect(button(page, 'Browse Library genres')).toHaveCount(0);
	expect(network.requests.filter((u) => u.searchParams.get('limit') === '500')).toHaveLength(0);
	await button(page, 'Settings').click();
	await button(page, 'Home layout').click();
	await button(page, 'Add Library genres').click();
	await button(page, 'Save layout').click();
	await button(page, 'Back').click();
	await button(page, 'Home').click();
	await button(page, 'Browse Library genres').click();
	const expanded = page.locator('[data-collection=expanded]');
	await expanded.getByRole('button', { name: 'Jazz', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Jazz', exact: true })).toBeVisible();
	await expect(button(page, 'Play Glow')).toBeVisible();
	expect(network.requests.filter((u) => u.searchParams.get('genre') === 'Jazz')).toHaveLength(1);
	await context.setOffline(true);
	network.setOffline(true);
	await expect(button(page, 'Play Night')).toHaveCount(0);
	await expect(button(page, 'Play Glow')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Jazz', exact: true })).toBeVisible();
	expect(network.blocked).toEqual([]);
	network.setOffline(false);
	await context.setOffline(false);
	await expect(button(page, 'Play Night')).toBeVisible();
	await button(page, 'Back to Library genres').click();
	await expect(expanded.getByRole('button', { name: 'Folk', exact: true })).toBeVisible();
	expect(network.requests.filter((u) => u.searchParams.get('limit') === '500')).toHaveLength(1);
});
