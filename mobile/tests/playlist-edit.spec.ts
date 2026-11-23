import { chooseOption, choiceList } from './fixtures/inlineChoice';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { silentWav } from './fixtures/silentWav';
import type { components } from '../../frontend/src/lib/api/v3/openapi';

type Schema = components['schemas'];
const server = 'https://library.example/dn';
const api = server + '/api/v3';
const local = ['Signal', 'Station'].map(
	(title, i) =>
		({
			id: 'file-' + i,
			title,
			artist_name: 'North',
			album_artist_name: 'North',
			album_id: 'album',
			album_title: i === 0 ? 'In transit' : '',
			disc_number: 1,
			track_number: i + 1,
			format: 'flac',
			file_size_bytes: 500,
			cover_available: false,
			art_missing: true,
			favorite: false,
			row_revision: 1
		}) satisfies Schema['TrackView']
);

function playlist(
	id: string,
	name: string,
	owner: boolean,
	edit: boolean
): Schema['PlaylistDetail'] {
	return {
		id,
		name,
		is_owner: owner,
		is_public: false,
		can_edit: edit,
		can_delete: owner,
		is_shared: !owner,
		is_redacted: false,
		cover_urls: [],
		created_at: 1,
		updated_at: 1,
		track_count: 0,
		tracks: []
	};
}
async function connect(page: Page) {
	const lists = [
		playlist('mine', 'My mix', true, true),
		playlist('shared', 'Shared mix', false, true),
		playlist('readonly', 'Listening room', false, false)
	];
	let members: Schema['PlaylistMember'][] = [];
	const covers = new Map<string, Schema['CoverUploadBody']>();
	function setCover(p: Schema['PlaylistDetail'], data?: Schema['CoverUploadBody']) {
		p.updated_at++;
		p.custom_cover_url = data ? '/api/v3/playlists/' + p.id + '/cover' : null;
		if (data) covers.set(p.id, data);
		else covers.delete(p.id);
	}
	const writes: string[] = [],
		streams: string[] = [];
	await page.route(api + '/**', async (route) => {
		const req = route.request(),
			method = req.method(),
			path = req.url().slice(api.length).split('?')[0];
		const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
		if (path === '/auth/providers')
			return json({ local: true, oidc: false, plex: false, jellyfin: false });
		if (path === '/auth/login') return json({ token: 'device-token' });
		expect(req.headers().authorization).toBe('Bearer device-token');
		if (method !== 'GET') writes.push(method + ' ' + path);
		if (path.startsWith('/stream/local/')) {
			streams.push(path.split('/').at(-1)!);
			return route.fulfill({ body: silentWav(), contentType: 'audio/wav' });
		}
		if (path.endsWith('/lyrics')) return json({ lines: [] });
		if (path === '/ratings/lookup') return json({ artists: {}, albums: {}, tracks: {} });
		if (path === '/me') return json({ id: 'listener', display_name: 'Listener' });
		if (path === '/users/directory')
			return json({
				users: [
					{ id: 'listener', display_name: 'Listener' },
					{ id: 'sam', display_name: 'Sam' }
				]
			});
		if (path === '/me/section-prefs') return json({ pages: { home: [] } });
		if (path === '/home') return json({ sections: [], refreshing: false });
		if (path === '/library/albums')
			return json({
				items: [
					{
						id: 'album',
						title: 'In transit',
						artist_name: 'North',
						artist_id: 'artist',
						identity_state: 'unidentified',
						guess_contradicted: false,
						track_count: 2,
						total_duration_seconds: 20,
						total_size_bytes: 1000,
						is_compilation: false,
						cover_available: false,
						art_missing: true,
						favorite: false
					}
				],
				total: 1
			});
		if (path === '/library/albums/match/album')
			return json({ items: local, total: 2, offset: 0, limit: 200 } satisfies Schema['TrackPage']);
		if (path === '/playlists/import') {
			expect(method).toBe('POST');
			expect(req.postDataJSON()).toEqual({
				name: 'Train ride',
				format: 'm3u8',
				content: '#EXTM3U\ntrack.flac\nmissing.flac'
			});
			lists.push(playlist('imported', 'Train ride', true, true));
			return json({
				playlist_id: 'imported',
				name: 'Train ride',
				matched: 1,
				unmatched: [{ title: 'missing.flac', artist: '', reason: 'no_match' }],
				over_limit: 0
			} satisfies Schema['ImportPlaylistResponse']);
		}
		if (path === '/playlists') {
			if (method === 'GET') return json({ playlists: lists });
			expect(method).toBe('POST');
			const p = playlist('created', req.postDataJSON().name, true, true);
			lists.push(p);
			return json(p, 201);
		}
		const [, group, id, ...parts] = path.split('/'),
			p = lists.find((item) => item.id === id);
		if (await emptyBoardRead(route)) return;
		if (group !== 'playlists' || !p) throw new Error('Unexpected request ' + method + ' ' + path);
		const action = parts.join('/');
		if (action === '') {
			if (method === 'GET') return json(p);
			if (method === 'PUT') {
				expect(p.is_owner).toBe(true);
				p.name = req.postDataJSON().name;
				return json(p);
			}
			if (method === 'DELETE') {
				expect(p.can_delete).toBe(true);
				lists.splice(lists.indexOf(p), 1);
				return json({ status: 'ok', message: 'Deleted' });
			}
		}
		if (action === 'cover') {
			if (method === 'GET') {
				expect(new URL(req.url()).searchParams.get('v')).toBe(String(p.updated_at));
				const image = covers.get(p.id);
				return image
					? route.fulfill({
							body: Buffer.from(image.image_base64, 'base64'),
							contentType: image.content_type
						})
					: json({}, 404);
			}
			expect(p.is_owner).toBe(true);
			if (method === 'POST') {
				const body = req.postDataJSON() as Schema['CoverUploadBody'];
				setCover(p, body);
				return json({ cover_url: p.custom_cover_url });
			}
			expect(method).toBe('DELETE');
			setCover(p);
			return json({ status: 'ok' });
		}
		if (action === 'visibility' && method === 'PATCH') {
			expect(p.is_owner).toBe(true);
			p.is_public = req.postDataJSON().is_public;
			return json(p);
		}
		if (action === 'members') {
			expect(p.is_owner).toBe(true);
			if (method === 'PUT') {
				const data = req.postDataJSON() as Schema['MembersBody'];
				members = data.user_ids.map((user_id) => ({
					user_id,
					display_name: 'Sam',
					can_edit: data.editor_ids?.includes(user_id) ?? false
				}));
			}
			return json({ members });
		}
		if (!p.can_edit)
			return json({ error: { code: 'FORBIDDEN', message: 'This playlist is read-only.' } }, 403);
		if (action === 'tracks' && method === 'POST') {
			const data = req.postDataJSON() as Schema['AddTracksBody'];
			const added = data.tracks.map((entry, i) => {
				expect(entry.source_type).toBe('local');
				expect(entry.available_sources).toEqual(['local']);
				return {
					...entry,
					source_type: 'local',
					id: 'entry-' + (i + p.tracks.length),
					position: i + p.tracks.length,
					created_at: 1
				};
			});
			p.tracks.push(...added);
			p.track_count = p.tracks.length;
			return json({ tracks: added });
		}
		if (action === 'tracks/reorder' && method === 'PATCH') {
			const data = req.postDataJSON() as Schema['ReorderBody'];
			const idx = p.tracks.findIndex((t) => t.id === data.track_id);
			expect(idx).toBeGreaterThanOrEqual(0);
			p.tracks.splice(data.new_position, 0, ...p.tracks.splice(idx, 1));
			return json({ status: 'ok', message: 'Moved', new_position: data.new_position });
		}
		if (parts[0] === 'tracks' && method === 'DELETE') {
			p.tracks = p.tracks.filter((t) => t.id !== parts[1]);
			p.track_count = p.tracks.length;
			return json({ status: 'ok', message: 'Removed' });
		}
		throw new Error('Unexpected request ' + method + ' ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	return { lists, writes, streams, covers, setCover, members: () => members };
}

test('owned playlist artwork syncs in both directions and can be restored from the library', async ({
	page
}) => {
	const state = await connect(page);
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Playlists' }).click();
	const playlist = page.getByRole('button', { name: 'My mix', exact: true });
	await playlist.click();
	const artwork = page.getByRole('button', { name: 'Change playlist artwork' });
	await artwork.click();
	const dialog = page.getByRole('dialog', { name: 'Playlist artwork' });
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 920;
		canvas.height = 640;
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'teal';
		context.fillRect(0, 0, canvas.width, canvas.height);
		return canvas.toDataURL().split(',')[1];
	});
	const photo = { name: 'art.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
	const endpoint = api + '/playlists/mine/cover';
	await page.route(endpoint, (r) =>
		r.fulfill({ status: 403, json: { error: { message: 'Cover update denied' } } })
	);
	await dialog.locator('input[type=file]').setInputFiles(photo);
	await expect(dialog.getByRole('alert')).toHaveText('Cover update denied');
	await expect(artwork.locator('img')).toHaveCount(0);
	await page.unroute(endpoint);
	await dialog.locator('input[type=file]').setInputFiles(photo);
	await expect(dialog).toHaveCount(0);
	await expect(artwork.locator('img')).toHaveJSProperty('naturalWidth', 512);
	expect(state.covers.get('mine')?.content_type).toBe('image/webp');
	await page.getByRole('button', { name: 'Back to playlists' }).click();
	await expect(playlist.locator('img')).toHaveJSProperty('naturalWidth', 512);
	state.setCover(state.lists[0], { content_type: 'image/png', image_base64: png });
	await playlist.click();
	await expect(artwork.locator('img')).toHaveJSProperty('naturalWidth', 920);
	await page.getByRole('button', { name: 'Back to playlists' }).click();
	await page.getByRole('button', { name: 'More options for My mix' }).click();
	await page.getByRole('button', { name: 'Use automatic artwork' }).click();
	await expect(playlist.locator('img')).toHaveCount(0);
	expect(state.writes.filter((line) => line.includes('/playlists/'))).toEqual([
		'POST /playlists/mine/cover',
		'DELETE /playlists/mine/cover'
	]);
});

test('a pinned playlist shows the current DN cover when Home opens', async ({ page }) => {
	const state = await connect(page);
	const nav = (name: string) => page.getByRole('button', { name, exact: true });
	await nav('Library').click();
	await nav('Browse Playlists').click();
	await nav('My mix').click();
	await nav('Pin to Home').click();
	await expect(nav('Unpin from Home')).toBeVisible();
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 21;
		return canvas.toDataURL().split(',')[1];
	});
	state.setCover(state.lists[0], { content_type: 'image/png', image_base64: png });
	await nav('Home').click();
	const art = page
		.getByRole('region', { name: 'Pinned to Home' })
		.getByRole('button', { name: /My mix/ })
		.locator('img');
	await expect(art).toHaveJSProperty('naturalWidth', 21);
	await nav('Library').click();
	state.setCover(state.lists[0]);
	await nav('Home').click();
	await expect(art).toHaveCount(0);
});

test('shared editors and listeners see playlist artwork without owner controls', async ({
	page
}) => {
	await connect(page);
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Playlists' }).click();
	for (const title of ['Shared mix', 'Listening room']) {
		await page.getByRole('button', { name: 'More options for ' + title }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('button', { name: /artwork/i })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: title, exact: true }).click();
		await expect(page.getByRole('heading', { name: title })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Change playlist artwork' })).toHaveCount(0);
		await page.getByRole('button', { name: 'Back to playlists' }).click();
	}
});

test('an owner creates, renames, shares and confirms deletion of a playlist', async ({ page }) => {
	const state = await connect(page);
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Playlists', exact: true }).click();
	await page.getByRole('button', { name: 'New playlist' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('button', { name: /Create empty playlist/ })).toBeDisabled();
	await dialog.getByLabel('Playlist name').fill('  Saturday  ');
	await dialog.getByRole('button', { name: /Create empty playlist/ }).click();
	await expect(page.getByRole('heading', { name: 'Saturday' })).toBeVisible();
	await page.getByRole('button', { name: 'Edit playlist', exact: true }).click();
	await page.getByRole('button', { name: 'Rename', exact: true }).click();
	await dialog.getByLabel('Playlist name').fill('Sunday');
	await dialog.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByRole('heading', { name: 'Sunday' })).toBeVisible();
	await page.getByRole('button', { name: 'Share playlist' }).click();
	await chooseOption(dialog.getByLabel('Who can listen'), { label: 'Everyone on this server' });
	await dialog.getByRole('button', { name: 'Save visibility' }).click();
	await expect(dialog.getByRole('status')).toHaveText('Everyone on this server can listen.');
	await dialog.getByLabel('Find a listener').fill('Sam');
	await dialog.getByRole('button', { name: 'Add Sam' }).click();
	await chooseOption(dialog.getByLabel('Access for Sam'), { label: 'Can edit tracks' });
	await dialog.getByRole('button', { name: 'Save listeners' }).click();
	await expect(dialog.getByRole('status')).toHaveText('Shared listeners updated.');
	expect(state.members()).toEqual([{ user_id: 'sam', display_name: 'Sam', can_edit: true }]);
	await dialog.getByRole('button', { name: 'Done' }).click();
	await page.getByRole('button', { name: 'Delete playlist' }).click();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	expect(state.writes).not.toContain('DELETE /playlists/created');
	await page.getByRole('button', { name: 'Delete playlist' }).click();
	await dialog.getByRole('button', { name: 'Delete playlist' }).click();
	await expect(page.getByRole('button', { name: 'My mix', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /Sunday/ })).toHaveCount(0);
});

test('a shared editor adds an album, reorders tracks and removes one occurrence', async ({
	page
}) => {
	const state = await connect(page);
	const dialog = page.getByRole('dialog', { name: 'Add to playlist' });
	await page.getByRole('button', { name: /In transit/ }).click();
	await page.getByRole('button', { name: 'Album actions' }).click();
	await page.getByRole('button', { name: 'Add to playlist', exact: true }).click();
	await choiceList(dialog.getByRole('combobox', { name: 'Playlist', exact: true }));
	await expect(dialog.getByRole('option', { name: 'Listening room' })).toHaveCount(0);
	await chooseOption(dialog.getByRole('combobox', { name: 'Playlist', exact: true }), 'shared');
	await dialog.getByRole('button', { name: 'Add 2 tracks' }).click();
	await expect(dialog.getByRole('status')).toHaveText('Added 2 tracks to Shared mix.');
	await dialog.getByRole('button', { name: 'Done' }).click();
	await page.getByRole('button', { name: 'More options for Signal' }).click();
	await page.getByRole('button', { name: 'Add to playlist', exact: true }).click();
	await chooseOption(dialog.getByRole('combobox', { name: 'Playlist', exact: true }), 'shared');
	await dialog.getByRole('button', { name: 'Add track', exact: true }).click();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Playlists', exact: true }).click();
	await page.getByRole('button', { name: 'Shared mix', exact: true }).click();
	await page.getByRole('button', { name: 'Edit playlist' }).click();
	await expect(
		page.getByRole('button', { name: /Rename|Share playlist|Delete playlist/ })
	).toHaveCount(0);
	const entries = page.locator('[data-entry]'),
		titles = entries.locator('strong');
	await expect(titles).toHaveText(['Signal', 'Station', 'Signal']);
	await entries.last().getByRole('button', { name: 'Reorder Signal, position 3' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Move Signal up' }).click();
	await expect(titles).toHaveText(['Signal', 'Signal', 'Station']);
	await entries.nth(1).getByRole('button', { name: 'Remove Signal' }).click();
	await page.keyboard.press('Escape');
	await expect(titles).toHaveCount(3);
	await entries.nth(1).getByRole('button', { name: 'Remove Signal' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Remove track' }).click();
	await expect(titles).toHaveText(['Signal', 'Station']);
	expect(state.lists[1].tracks.map((t) => t.track_source_id)).toEqual(['file-0', 'file-1']);
	expect(state.lists[1].tracks[1].album_name).toBe('Unknown album');
	expect(state.writes).toContain('DELETE /playlists/shared/tracks/entry-2');
	await page.getByRole('button', { name: 'Back to playlists' }).click();
	await page.getByRole('button', { name: 'Listening room', exact: true }).click();
	await expect(page.getByText('This playlist is empty.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit playlist' })).toHaveCount(0);
});

test('a listener names an imported playlist and reviews unmatched local entries', async ({
	page
}) => {
	const state = await connect(page);
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Playlists', exact: true }).click();
	await page.getByRole('button', { name: 'Import playlist', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Playlist file').setInputFiles({
		name: 'mix.zip',
		mimeType: 'application/zip',
		buffer: Buffer.from('unsupported')
	});
	await expect(dialog.getByRole('alert')).toHaveText('Choose an M3U, M3U8 or CSV file.');
	await dialog.getByLabel('Playlist file').setInputFiles({
		name: 'trip.M3U8',
		mimeType: 'audio/x-mpegurl',
		buffer: Buffer.from('#EXTM3U\ntrack.flac\nmissing.flac')
	});
	await expect(dialog.getByLabel('Playlist name')).toHaveValue('trip');
	await dialog.getByLabel('Playlist name').fill('Train ride');
	expect(state.writes).toHaveLength(0);
	await dialog.getByRole('button', { name: 'Create from file' }).click();
	await expect(dialog).toHaveAccessibleName('Playlist imported');
	await dialog.getByText('Unmatched entries (1)').click();
	await expect(dialog.getByText(/No matching local file/)).toBeVisible();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await expect(page.getByRole('button', { name: 'Train ride', exact: true })).toBeVisible();
	expect(state.writes).toEqual(['POST /playlists/import']);
});

async function openTouchPlaylist(page: Page, length = 4) {
	await page.setViewportSize({ width: 360, height: 760 });
	await page.addInitScript(() => {
		const Audio = window.Audio;
		window.Audio = new Proxy(Audio, {
			construct(target, args) {
				const audio = Reflect.construct(target, args) as HTMLAudioElement;
				Object.assign(window, { fixtureAudio: audio });
				return audio;
			}
		});
	});
	const state = await connect(page);
	const tracks = Array.from({ length }, (_, i) => {
		const song = [0, 1, 0, 2][i] ?? i;
		return {
			id: 'entry-' + i,
			position: i,
			created_at: 1,
			track_name: ['Signal', 'Station', 'Destination'][song] ?? 'Track ' + i,
			artist_name: 'North',
			album_name: 'In transit',
			duration: 60,
			source_type: 'local',
			track_source_id: 'file-' + song,
			available_sources: ['local']
		} satisfies Schema['PlaylistTrack'];
	});
	for (const p of state.lists.slice(1)) {
		p.tracks = [...tracks];
		p.track_count = length;
	}
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Playlists', exact: true }).click();
	await page.getByRole('button', { name: 'Shared mix', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Shared mix' })).toBeVisible();
	return state;
}

async function dragRow(
	page: Page,
	source: Locator,
	destination: Locator,
	cancel = false,
	held?: () => Promise<void>
) {
	const grip = source.getByRole('button', { name: /^Reorder / });
	await grip.evaluate((node) => {
		const main = node.closest('main')!;
		main.scrollTop += node.getBoundingClientRect().top - main.getBoundingClientRect().top - 200;
	});
	await expect(grip).toBeInViewport();
	await expect(destination).toBeInViewport();
	const start = (await grip.boundingBox())!,
		end = (await destination.boundingBox())!;
	const x = start.x + start.width / 2,
		from = start.y + start.height / 2,
		to = end.y + end.height / 2;
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('Input.dispatchTouchEvent', {
			type: 'touchStart',
			touchPoints: [{ x, y: from }]
		});
		for (let i = 1; i <= 6; i++)
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x, y: from + ((to - from) * i) / 6 }]
			});
		await expect(destination).toHaveAttribute('data-reorder-drop', /before|after/);
		await held?.();
		await cdp.send('Input.dispatchTouchEvent', {
			type: cancel ? 'touchCancel' : 'touchEnd',
			touchPoints: []
		});
	} finally {
		await cdp.detach();
	}
}
type AudioFixture = Window & { fixtureAudio: HTMLAudioElement };

test('touch reorders the selected occurrence in a shared playlist, with cancel, keyboard and exact positions', async ({
	page
}) => {
	const state = await openTouchPlaylist(page, 55);
	const rows = page.locator('[data-entry]');
	await page.getByRole('button', { name: 'Edit playlist' }).tap();
	const initial = state.lists[1].tracks.map((t) => t.id);
	await dragRow(page, rows.nth(2), rows.first(), true);
	expect(state.writes).toEqual([]);
	await expect(rows.nth(2)).toHaveAttribute('data-entry', 'entry-2');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await dragRow(page, rows.nth(2), rows.first(), false, () => page.keyboard.press('Escape'));
	expect(state.writes).toEqual([]);
	await expect(page.getByRole('heading', { name: 'Shared mix' })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await dragRow(page, rows.nth(2), rows.first());
	await expect(rows.first()).toHaveAttribute('data-entry', 'entry-2');
	expect(state.lists[1].tracks.map((t) => t.id)).toEqual([
		'entry-2',
		...initial.filter((id) => id !== 'entry-2')
	]);
	const first = rows.first().getByRole('button', { name: 'Reorder Signal, position 1' });
	await first.focus();
	await page.keyboard.press('ArrowDown');
	await expect(rows.nth(1)).toHaveAttribute('data-entry', 'entry-2');
	await expect(
		rows.nth(1).getByRole('button', { name: 'Reorder Signal, position 2' })
	).toBeFocused();
	await page.keyboard.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Move Signal' });
	await dialog.getByLabel('Track position', { exact: false }).fill('55');
	await dialog.getByRole('button', { name: 'Move track' }).click();
	await expect.poll(() => state.lists[1].tracks.at(-1)?.id).toBe('entry-2');
	await expect(
		page.getByRole('status').filter({ hasText: 'Moved Signal to position 55.' })
	).toBeVisible();
	await page.getByRole('button', { name: 'More tracks', exact: true }).tap();
	await expect(rows.last()).toHaveAttribute('data-entry', 'entry-2');
	expect(state.writes).toEqual(Array(3).fill('PATCH /playlists/shared/tracks/reorder'));
	await page.getByRole('button', { name: 'Back to playlists' }).click();
	await page.getByRole('button', { name: 'Listening room', exact: true }).click();
	await expect(rows).toHaveCount(50);
	await expect(page.getByRole('button', { name: /Edit playlist|^Reorder / })).toHaveCount(0);
});

test('queue drags preserve the playing duplicate through a track transition and reject a changed queue', async ({
	page
}) => {
	const state = await openTouchPlaylist(page);
	await page.locator('[data-entry="entry-2"]').getByRole('button', { name: 'Play Signal' }).tap();
	await page.getByRole('button', { name: 'Show play queue' }).tap();
	await page.getByRole('button', { name: 'Edit queue' }).tap();
	const queue = page.locator('[data-part="play-queue"]');
	const rows = queue.locator('li'),
		playing = queue.locator('li:has([aria-current=true])');
	await expect(playing).toHaveAttribute('data-reorder-row', '2');
	await page.evaluate(() => {
		(window as unknown as AudioFixture).fixtureAudio.currentTime = 8;
	});
	await dragRow(page, rows.nth(2), rows.first());
	await expect(playing).toHaveAttribute('data-reorder-row', '0');
	await expect(rows.locator('strong')).toHaveText(['Signal', 'Signal', 'Station', 'Destination']);
	expect(state.streams).toEqual(['file-0']);
	const transport = await page.evaluate(() => {
		const audio = (window as unknown as AudioFixture).fixtureAudio;
		return { playing: !audio.paused, at: audio.currentTime };
	});
	expect(transport.playing).toBe(true);
	expect(transport.at).toBeGreaterThanOrEqual(8);
	await dragRow(page, rows.first(), rows.last(), false, async () => {
		await page.evaluate(() =>
			(window as unknown as AudioFixture).fixtureAudio.dispatchEvent(new Event('ended'))
		);
		await expect(playing).toHaveAttribute('data-reorder-row', '1');
	});
	await expect(rows.locator('strong')).toHaveText(['Signal', 'Station', 'Destination', 'Signal']);
	await expect(playing).toHaveAttribute('data-reorder-row', '0');
	await dragRow(page, rows.first(), rows.nth(2), false, async () => {
		await queue
			.getByRole('button', { name: 'Remove Station from queue' })
			.evaluate((el) => (el as HTMLButtonElement).click());
		await expect(rows).toHaveCount(3);
	});
	await expect(queue.getByRole('status')).toHaveText('The list changed. Choose the track again.');
	await expect(rows.locator('strong')).toHaveText(['Signal', 'Destination', 'Signal']);
	await expect(playing).toHaveAttribute('data-reorder-row', '0');
	expect(state.streams).toEqual(['file-0', 'file-0']);
});

test('a server permission change while a playlist is open leaves its entries in their original order', async ({
	page
}) => {
	const state = await openTouchPlaylist(page);
	await page.getByRole('button', { name: 'Edit playlist' }).tap();
	const rows = page.locator('[data-entry]');
	state.lists[1].can_edit = false;
	await dragRow(page, rows.nth(2), rows.first());
	await expect(page.getByRole('alert')).toHaveText('This playlist is read-only.');
	await expect(
		page.getByRole('button', { name: /Edit playlist|Done editing|^Reorder / })
	).toHaveCount(0);
	await expect(rows.nth(2)).toHaveAttribute('data-entry', 'entry-2');
	expect(state.writes).toEqual(['PATCH /playlists/shared/tracks/reorder']);
});
