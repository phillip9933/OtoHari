import { chooseOption, choiceList } from './fixtures/inlineChoice';
import { expect, test, type Page } from '@playwright/test';
import type { PlayerTrack } from '../src/lib/player';
import { playlistId, playlistSource } from '../src/lib/offline/tracks';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';
import { silentWav } from './fixtures/silentWav';

const server = 'https://playlist-offline.example/dn';
const playlist = '暮れの曲';
const alternate = 'daylight';
const named = (id: string, name = id) => ({ id, name, is_redacted: false, cover_urls: [] });
const song = (id: string, position: number) => ({
	id: 'entry-' + position,
	position,
	source_type: 'local',
	library_file_id: id,
	album_id: id === 'new' ? 'album-7' : id === 's2' ? null : 'album',
	...(id === 'new'
		? { artist_id: 'artist-9', format: 'FLAC', disc_number: 2, track_number: 4 }
		: {}),
	track_name: id,
	artist_name: 'Lake',
	album_name: 'Window',
	available_sources: ['local']
});
async function setup(page: Page) {
	const audio = silentWav(1);
	let user = 'listener';
	const state = {
		files: ['one', 'two'],
		owner: true,
		ambiguous: false,
		status: 200,
		countDelta: 0,
		resolveStatus: 200,
		reads: 0,
		resolutions: 0,
		streams: [] as string[],
		audioStatus: new Map<string, number>(),
		ratings: [] as number[]
	};
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request();
		const path = decodeURIComponent(new URL(req.url()).pathname.split('/api/v3/')[1]);
		const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
		if (path === 'auth/providers') return json({ local: true, oidc: false });
		if (path === 'auth/login') {
			user = req.postDataJSON().username;
			return json({ token: 'test-' + user });
		}
		if (path === 'me') return json({ id: user, display_name: user, role: 'user' });
		if (path === 'playlists')
			return json({
				playlists: [
					named(playlist, user + ' evening'),
					named(alternate, 'Daylight'),
					named('bad/id')
				]
			});
		if (path.startsWith('playlists/')) {
			const id = path.split('/')[1];
			if (path.endsWith('/resolve-sources')) {
				state.resolutions++;
				return json({ sources: {} }, state.resolveStatus);
			}
			state.reads++;
			if (state.status !== 200) return json({ error: { code: 'fixture' } }, state.status);
			const rows = (id === alternate ? ['sun'] : state.files).map(song);
			if (id === playlist && state.ambiguous)
				rows.push({ ...song('', rows.length), source_type: '', available_sources: [] });
			return json({
				...named(id, id === alternate ? 'Daylight' : user + ' evening'),
				is_owner: state.owner,
				track_count: rows.length + state.countDelta,
				tracks: rows
			});
		}
		if (path.startsWith('stream/local/')) {
			const id = path.split('/')[2];
			state.streams.push(id);
			const status = state.audioStatus.get(id);
			if (status) {
				expect(new URL(req.url()).searchParams.get('format')).toBe('raw');
				return json({ error: { message: 'fixture response' } }, status);
			}
			return route.fulfill({ body: audio, contentType: 'audio/wav' });
		}
		if (path === 'ratings/lookup') {
			if (req.postDataJSON().track_ids) state.ratings.push(req.postDataJSON().track_ids.length);
			return json({ error: { code: 'unavailable' } }, 503);
		}
		if (await emptyBoardRead(route)) return;
		return json({ error: { code: 'not_found' } }, 404);
	});
	return state;
}
async function switchSettingsPage(page: Page, name: string) {
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name, exact: true }).click();
}
async function settings(page: Page) {
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Download preferences' }).click();
	await expect(page.getByLabel('Download source')).toBeVisible();
}
async function choose(page: Page, id = playlist) {
	await chooseOption(page.getByLabel('Download source'), 'playlist');
	await chooseOption(page.getByRole('combobox', { name: 'DN playlist', exact: true }), id);
}
async function storedTracks(page: Page, who = 'listener') {
	return page.evaluate(
		async ({ server, who }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const r = indexedDB.open('dn.mobile.offline.v1');
				r.onsuccess = () => resolve(r.result);
				r.onerror = () => reject(r.error);
			});
			try {
				const read = db
					.transaction('tracks')
					.objectStore('tracks')
					.index('scope')
					.getAll(JSON.stringify([server, who]));
				return await new Promise<{ origin: string; track: PlayerTrack }[]>((resolve, reject) => {
					read.onsuccess = () =>
						resolve(read.result.map(({ origin, track }) => ({ origin, track })));
					read.onerror = () => reject(read.error);
				});
			} finally {
				db.close();
			}
		},
		{ server, who }
	);
}
async function copies(page: Page, who = 'listener') {
	return (await storedTracks(page, who)).map((row) => row.origin + ':' + row.track.id).sort();
}
const syncButton = (page: Page) =>
	page.getByRole('button', { name: 'Update automatic downloads', exact: true });

test('playlist source IDs round-trip exactly, with UTF-8 byte bounds and a single spelling', () => {
	for (const id of ['🌿'.repeat(64), 'id/with:spaces and +', '\ufefftext', playlist]) {
		expect(playlistId(playlistSource(id))).toBe(id);
	}
	for (const id of ['', '.', '..', '\u0000', '\u009f', '\ud800', '🌿'.repeat(65)])
		expect(playlistSource(id)).toBeNull();
	for (const value of ['playlist:', 'playlist:YQ=', 'playlist:YR', 'playlist:_w', 'favorites'])
		expect(playlistId(value)).toBeNull();
});

test('selection syncs the full playlist in order, preserves manual copies and isolates two cold accounts', async ({
	page
}) => {
	const env = await setup(page);
	const ids = Array.from({ length: 103 }, (_, i) => 's' + i);
	env.files = [ids[0], ids[0], ...ids.slice(1)];
	await localSignIn(page, server);
	await settings(page);
	await choose(page);
	await expect(page.getByText('103 automatic downloads added.', { exact: true })).toBeVisible();
	expect(env.streams).toEqual(ids);
	expect(env.ratings).toEqual([100, 3]);
	await choiceList(page.getByRole('combobox', { name: 'DN playlist', exact: true }));
	await expect(page.getByRole('option', { name: 'bad/id' })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await switchSettingsPage(page, 'Device storage');
	await page.getByRole('button', { name: 'Open offline music' }).click();
	const shelf = page.getByRole('region', { name: 'Offline music' });
	await shelf.getByRole('button', { name: 'Automatic downloads', exact: true }).click();
	await shelf.getByRole('button', { name: 'Keep s0 offline', exact: true }).click();
	await settings(page);
	env.files = ['new', 's2', 'new'];
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect.poll(() => copies(page)).toEqual(['automatic:new', 'automatic:s2', 'downloaded:s0']);
	await switchSettingsPage(page, 'Offline mode and playback cache');
	await page.getByRole('checkbox', { name: 'Offline mode', exact: true }).check();
	await switchSettingsPage(page, 'Download preferences');
	await expect(page.getByLabel('Download source')).toBeEnabled();
	await expect(syncButton(page)).toBeDisabled();
	await localSignIn(page, server, 'another');
	await settings(page);
	await expect(page.getByLabel('Download source')).toHaveAttribute('data-value', 'off');
	await choose(page, alternate);
	await expect(page.getByText('1 automatic download added.', { exact: true })).toBeVisible();
	const reads = env.reads;
	await localSignIn(page, server, 'listener', 'Offline music');
	await settings(page);
	await switchSettingsPage(page, 'Offline mode and playback cache');
	await expect(page.getByRole('checkbox', { name: 'Offline mode', exact: true })).toBeChecked();
	await switchSettingsPage(page, 'Download preferences');
	await page.context().setOffline(true);
	await expect(page.getByRole('combobox', { name: 'DN playlist', exact: true })).toHaveAttribute(
		'data-value',
		playlist
	);
	await choiceList(page.getByRole('combobox', { name: 'DN playlist', exact: true }));
	await expect(page.getByRole('option', { name: 'listener evening' })).toBeAttached();
	await page.keyboard.press('Escape');
	expect(env.reads).toBe(reads);
	const cold = (await storedTracks(page)).map((row) => row.track);
	expect(cold.find((t) => t.id === 'new')).toMatchObject({
		albumId: 'album-7',
		artistId: 'artist-9',
		format: 'FLAC',
		discNumber: 2,
		trackNumber: 4
	});
	const untagged = cold.find((t) => t.id === 's2');
	expect(untagged).toBeDefined();
	for (const key of ['albumId', 'artistId', 'format', 'discNumber', 'trackNumber'])
		expect(untagged).not.toHaveProperty(key);
	await page.getByRole('button', { name: 'Remove automatic playlist downloads' }).click();
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(await copies(page)).toEqual(['automatic:new', 'automatic:s2', 'downloaded:s0']);
	await page.getByRole('button', { name: 'Remove automatic playlist downloads' }).click();
	await page.getByRole('button', { name: 'Turn off and remove automatic copies' }).click();
	await expect(page.getByLabel('Download source')).toHaveAttribute('data-value', 'off');
	expect(await copies(page)).toEqual(['downloaded:s0']);
	expect(await copies(page, 'another')).toEqual(['automatic:sun']);
});

test('incomplete reads preserve downloads, viewers can add playable entries, and lost access permits switching', async ({
	page
}) => {
	const env = await setup(page);
	await localSignIn(page, server);
	await settings(page);
	await choose(page);
	await expect(page.getByText('2 automatic downloads added.', { exact: true })).toBeVisible();
	env.files = ['new'];
	env.countDelta = 1;
	await syncButton(page).click();
	await expect(page.getByText(/Could not confirm the complete playlist/)).toBeVisible();
	expect(await copies(page)).toEqual(['automatic:one', 'automatic:two']);
	env.countDelta = 0;
	env.ambiguous = true;
	env.resolveStatus = 503;
	await syncButton(page).click();
	await expect.poll(() => env.resolutions).toBe(1);
	await expect(syncButton(page)).toBeEnabled();
	expect(await copies(page)).toEqual(['automatic:one', 'automatic:two']);
	env.resolveStatus = 200;
	await syncButton(page).click();
	await expect.poll(() => env.resolutions).toBe(2);
	await expect(syncButton(page)).toBeEnabled();
	expect(await copies(page)).toEqual(['automatic:one', 'automatic:two']);
	env.owner = false;
	await syncButton(page).click();
	await expect(page.getByText(/Some entries have no confirmed local file/)).toBeVisible();
	await expect
		.poll(() => copies(page))
		.toEqual(['automatic:new', 'automatic:one', 'automatic:two']);
	expect(env.resolutions).toBe(2);
	env.status = 404;
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(page.getByText(/deleted or you no longer have access/)).toBeVisible();
	expect(await copies(page)).toEqual(['automatic:new', 'automatic:one', 'automatic:two']);
	env.status = 200;
	await chooseOption(page.getByRole('combobox', { name: 'DN playlist', exact: true }), alternate);
	await expect.poll(() => copies(page)).toEqual(['automatic:sun']);
});

test('missing originals let later playlist tracks finish, then retry only the unavailable files', async ({
	page
}) => {
	const env = await setup(page);
	env.files = ['First', 'Old tape', 'Lost mix', 'Soundcheck', 'Encore', 'Last'];
	for (const [i, title] of env.files.slice(1, -1).entries())
		env.audioStatus.set(title, i % 2 ? 410 : 404);
	await localSignIn(page, server);
	await settings(page);
	await choose(page);
	await expect.poll(() => env.streams).toEqual(env.files);
	await expect.poll(() => copies(page)).toEqual(['automatic:First', 'automatic:Last']);
	const warning = page.getByText(/The next update will retry/);
	await expect(warning).toContainText('Old tape');
	await expect(warning).toContainText('Lost mix');
	await expect(warning).toContainText('Soundcheck');
	await expect(warning).toContainText('1 more');
	await expect(warning).not.toContainText('Encore');
	await expect(page.getByText('2 automatic downloads added.', { exact: true })).toBeVisible();
	env.audioStatus.clear();
	await syncButton(page).click();
	await expect(page.getByText('4 automatic downloads added.', { exact: true })).toBeVisible();
	expect(env.streams).toEqual([...env.files, ...env.files.slice(1, -1)]);
	await expect(warning).toHaveCount(0);
	// Permission and server errors apply to the whole batch, even if their body mentions a missing file.
	for (const status of [401, 403, 503]) {
		env.files.push('blocked-' + status, 'later-' + status);
		const first = env.files.find((title) => title.startsWith('blocked'))!;
		env.audioStatus.set(first, status);
		const before = env.streams.length;
		await syncButton(page).click();
		await expect(page.getByRole('alert')).toContainText('DN could not serve this audio file.');
		expect(env.streams.slice(before)).toEqual([first]);
	}
});

async function switchWhileRefreshing(page: Page) {
	const env = await setup(page);
	await localSignIn(page, server);
	await settings(page);
	await choose(page);
	await expect(page.getByText('2 automatic downloads added.', { exact: true })).toBeVisible();
	let resume!: () => void;
	const release = new Promise<void>((resolve) => {
		resume = resolve;
	});
	let entered = false;
	await page.route(
		server + '/api/v3/playlists/' + encodeURIComponent(playlist),
		async (route) => {
			entered = true;
			await release;
			await route.fulfill({
				json: { ...named(playlist), is_owner: true, track_count: 1, tracks: [song('stale', 0)] }
			});
		},
		{ times: 1 }
	);
	try {
		await syncButton(page).click();
		await expect.poll(() => entered).toBe(true);
		const picker = page.getByRole('combobox', { name: 'DN playlist', exact: true });
		await chooseOption(picker, alternate);
		await expect.poll(() => copies(page)).toEqual(['automatic:sun']);
		env.files = ['current'];
		await chooseOption(picker, playlist);
		await expect.poll(() => copies(page)).toEqual(['automatic:current']);
	} finally {
		resume();
	}
	await expect(syncButton(page)).toBeEnabled();
	expect(env.streams).toEqual(['one', 'two', 'sun', 'current']);
}

test('a superseded playlist response cannot replace the newest selection after a round trip', async ({
	page
}) => {
	await switchWhileRefreshing(page);
});

test('an older WebView can browse playlists and cancel a superseded refresh', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
	});
	await switchWhileRefreshing(page);
});
