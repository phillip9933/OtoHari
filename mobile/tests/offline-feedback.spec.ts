import { chooseOption } from './fixtures/inlineChoice';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { emptyBoardRead } from './fixtures/emptyBoardRead';

const server = 'https://feedback.example/dn';
const audio = readFileSync(
	new URL('../android/app/src/androidTest/assets/offline/silence.mp3', import.meta.url)
);
const song = {
	id: 't',
	title: 'Starlight',
	artist_name: 'North',
	album_id: 'a',
	album_title: 'Sleeper',
	duration_seconds: 12,
	format: 'mp3',
	genre: 'Folk',
	year: 2020,
	track_number: 1,
	disc_number: 1,
	art_missing: true
};
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function login(page: Page, username: string, offline = false) {
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await button(page, 'Continue').click();
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await button(page, 'Sign in').click();
	await expect(
		page.getByRole('heading', { name: offline ? 'Offline music' : 'Home', exact: true })
	).toBeVisible();
}
async function fixture(page: Page) {
	const writes: { user: string; field: string; value: number | boolean }[] = [];
	const accounts = new Map<string, string>(),
		logins = new Map<string, number>(),
		writingLogins: number[] = [];
	const favorites = new Map<string, boolean>(),
		ratings = new Map<string, number>();
	let rejectFavorite = false,
		hold: Promise<void> | undefined,
		release: (() => void) | undefined,
		staleLookup: Promise<void> | undefined,
		releaseLookup: (() => void) | undefined,
		lookupStarted = false;
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url()),
			path = url.pathname.slice('/dn/api/v3'.length),
			json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') {
			const user = req.postDataJSON().username,
				login = (logins.get(user) ?? 0) + 1,
				token = 'test-secret-' + user + '-' + login;
			accounts.set(token, user);
			logins.set(user, login);
			return json({ token });
		}
		const token = req.headers().authorization?.replace('Bearer ', '') ?? '',
			user = accounts.get(token) ?? '';
		expect(['alice', 'bob']).toContain(user);
		if (path === '/me') return json({ id: user, display_name: user, role: 'user' });
		if (path === '/library/albums')
			return json({
				items: [{ id: 'a', title: 'Sleeper', artist_name: 'North', art_missing: true }],
				total: 1,
				next: null
			});
		if (path === '/library/tracks' || path === '/library/albums/match/a')
			return json({
				items: [{ ...song, favorite: favorites.get(user) ?? false }],
				total: 1,
				next: null
			});
		if (path === '/stream/local/t')
			return route.fulfill({ body: audio, contentType: 'audio/mpeg' });
		if (path === '/ratings/lookup') {
			const rating = ratings.get(user) ?? 0;
			if (staleLookup) {
				const waiting = staleLookup;
				staleLookup = undefined;
				lookupStarted = true;
				await waiting;
			}
			return json({ tracks: { t: rating }, albums: {}, artists: {} });
		}
		if (path === '/ratings/track/t' || path === '/favorites/track/t') {
			expect(req.method()).toBe('PUT');
			expect(url.search).toBe('');
			const field = path.startsWith('/ratings') ? 'rating' : 'favorite';
			const value = field === 'rating' ? req.postDataJSON().rating : req.postDataJSON().favorited;
			expect(token).toBe('test-secret-' + user + '-' + logins.get(user));
			writingLogins.push(logins.get(user)!);
			writes.push({ user, field, value });
			if (field === 'rating' && hold) {
				const pending = hold;
				hold = undefined;
				await pending;
			}
			if (field === 'favorite' && rejectFavorite)
				return route.fulfill({
					status: 409,
					json: { error: { code: 'CONFLICT', message: 'Changed on DN.' } }
				});
			if (field === 'rating') {
				ratings.set(user, value);
				return json({ item_id: 't', kind: 'track', rating: value });
			}
			favorites.set(user, value);
			return json({ item_id: 't', kind: 'track', favorited: value });
		}
		if (await emptyBoardRead(route)) return;
		return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
	});
	return {
		writes,
		writingLogins,
		reject: (v: boolean) => (rejectFavorite = v),
		pauseRating: () => {
			hold = new Promise<void>((r) => (release = r));
		},
		resumeRating: () => release?.(),
		pauseLookup: () => {
			staleLookup = new Promise<void>((r) => (releaseLookup = r));
		},
		resumeLookup: () => releaseLookup?.(),
		lookupStarted: () => lookupStarted
	};
}
async function download(page: Page) {
	await page
		.getByRole('button', { name: /Sleeper/ })
		.first()
		.click();
	await button(page, 'Album actions').click();
	const modal = page.getByRole('dialog');
	await modal.getByRole('button', { name: 'Save offline', exact: true }).click();
	await expect(modal.getByText('1 song saved offline.', { exact: true })).toBeVisible();
	await modal.getByRole('button', { name: 'Close', exact: true }).click();
}
async function settings(page: Page) {
	await button(page, 'Settings').click();
	await button(page, 'Offline mode and playback cache').click();
	await expect(page.getByRole('checkbox', { name: 'Offline mode', exact: true })).toBeEnabled();
}
async function shelf(page: Page) {
	await button(page, 'Library').click();
	await button(page, 'Offline music').click();
}
async function edit(page: Page) {
	const shelf = page.getByRole('region', { name: 'Offline music' });
	await shelf.getByRole('button', { name: 'Options for Starlight', exact: true }).click();
	return page.getByRole('dialog');
}
async function changes(page: Page) {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((ok, no) => {
			const req = indexedDB.open('dn.mobile.track-feedback');
			req.onsuccess = () => ok(req.result);
			req.onerror = () => no(req.error);
		});
		try {
			return await new Promise<
				{ scope: string; field: string; value: boolean | number; state: string }[]
			>((ok, no) => {
				const req = db.transaction('edits').objectStore('edits').getAll();
				req.onsuccess = () => ok(req.result);
				req.onerror = () => no(req.error);
			});
		} finally {
			db.close();
		}
	});
}
async function smartList(page: Page, create = false) {
	await button(page, 'Library').click();
	await button(page, 'Browse Playlists').click();
	if (create) {
		await button(page, 'New playlist').click();
		await page
			.getByRole('dialog')
			.getByRole('button', { name: /^Smart playlist/ })
			.click();
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Playlist name').fill('Loved five stars');
		await dialog.getByLabel('Favorites only').check();
		await chooseOption(dialog.getByLabel('Playlist rating', { exact: true }), '5');
		await dialog.getByRole('button', { name: 'Create smart playlist', exact: true }).click();
	}
	await button(page, 'Loved five stars').click();
}

test('airplane edits immediately qualify for a smart playlist and only the original account sends its latest values', async ({
	page
}) => {
	const env = await fixture(page);
	await login(page, 'alice');
	await download(page);
	await settings(page);
	await page.getByRole('checkbox', { name: 'Offline mode', exact: true }).check();
	await button(page, 'Back').click();
	await button(page, 'Device storage').click();
	await button(page, 'Open offline music').click();
	await page.context().setOffline(true);
	const dialog = await edit(page);
	await dialog.getByRole('button', { name: 'Favorite track', exact: true }).click();
	await dialog.getByRole('button', { name: 'Rate 2 stars', exact: true }).click();
	await dialog.getByRole('button', { name: 'Rate 5 stars', exact: true }).click();
	await expect(dialog.getByRole('button', { name: 'Rate 5 stars', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(dialog.getByText('2 track changes waiting to sync.', { exact: true })).toBeVisible();
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await smartList(page, true);
	await expect(button(page, 'Play Starlight')).toBeVisible();
	expect(env.writes).toEqual([]);
	await page.context().setOffline(false);
	await login(page, 'bob');
	await shelf(page);
	await expect(page.getByText('2 track changes waiting to sync.')).toHaveCount(0);
	expect(env.writes).toEqual([]);
	await login(page, 'alice', true);
	await expect(page.getByText('2 track changes waiting to sync.', { exact: true })).toBeVisible();
	const queue = await changes(page);
	expect(queue).toHaveLength(2);
	expect(queue.map((r) => [r.field, r.value, r.state])).toEqual([
		['favorite', true, 'pending'],
		['rating', 5, 'pending']
	]);
	expect(JSON.stringify(queue)).not.toContain('test-secret');
	await settings(page);
	await page.getByRole('checkbox', { name: 'Offline mode', exact: true }).uncheck();
	await expect
		.poll(() => env.writes)
		.toEqual([
			{ user: 'alice', field: 'favorite', value: true },
			{ user: 'alice', field: 'rating', value: 5 }
		]);
	await expect
		.poll(async () => (await changes(page)).every((r) => r.state === 'confirmed'))
		.toBe(true);
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await button(page, 'Back').click();
	await button(page, 'Device storage').click();
	await button(page, 'Open offline music').click();
	await expect(page.getByText(/track change.*waiting to sync/)).toHaveCount(0);
	expect(env.writes).toHaveLength(2);
	await page.context().setOffline(true);
	await button(page, 'Play all').click();
	await button(page, 'More actions').click();
	const actions = page.getByRole('dialog', { name: 'More actions', exact: true });
	await actions.getByRole('button', { name: 'Remove track from favorites', exact: true }).click();
	await actions.getByRole('button', { name: 'Rate 5 stars', exact: true }).click();
	await expect(
		actions.getByRole('button', { name: 'Favorite track', exact: true })
	).toHaveAttribute('aria-pressed', 'false');
	await actions.getByRole('button', { name: 'Close player', exact: true }).click();
	await button(page, 'Library').click();
	await button(page, 'Browse Playlists').click();
	await expect(page.getByText('No matching playlists.', { exact: true })).toBeVisible();
	await expect(button(page, 'Loved five stars')).toHaveCount(0);
	expect(env.writes).toHaveLength(2);
	await page.context().setOffline(false);
	await expect
		.poll(() => env.writes.slice(2))
		.toEqual([
			{ user: 'alice', field: 'favorite', value: false },
			{ user: 'alice', field: 'rating', value: 0 }
		]);
	expect(env.writingLogins).toEqual([2, 2, 2, 2]);
});

test('a newer rating survives an in-flight PUT and a rejected favorite is retried explicitly', async ({
	page
}) => {
	const env = await fixture(page);
	await login(page, 'alice');
	await download(page);
	await shelf(page);
	env.pauseLookup();
	const dialog = await edit(page);
	await expect.poll(env.lookupStarted).toBe(true);
	env.pauseRating();
	await dialog.getByRole('button', { name: 'Rate 2 stars', exact: true }).click();
	await expect
		.poll(() => env.writes.filter((r) => r.field === 'rating').map((r) => r.value))
		.toEqual([2]);
	await dialog.getByRole('button', { name: 'Rate 4 stars', exact: true }).click();
	await dialog.getByRole('button', { name: 'Rate 5 stars', exact: true }).click();
	// Keep the older request in flight until the latest edit reaches the device outbox.
	await expect
		.poll(async () =>
			(await changes(page)).filter((r) => r.field === 'rating').map((r) => [r.value, r.state])
		)
		.toEqual([[5, 'pending']]);
	env.resumeRating();
	await expect
		.poll(() => env.writes.filter((r) => r.field === 'rating').map((r) => r.value))
		.toEqual([2, 5]);
	await expect
		.poll(async () =>
			(await changes(page)).filter((r) => r.field === 'rating').map((r) => [r.value, r.state])
		)
		.toEqual([[5, 'confirmed']]);
	const finished = page.waitForResponse((response) => response.url().endsWith('/ratings/lookup'));
	env.resumeLookup();
	await finished;
	await expect(dialog.getByRole('button', { name: 'Rate 5 stars' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	env.reject(true);
	await dialog.getByRole('button', { name: 'Favorite track', exact: true }).click();
	await expect(dialog.getByText('DN could not apply your track changes.')).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	expect(env.writes.filter((r) => r.field === 'favorite')).toHaveLength(1);
	await expect
		.poll(async () =>
			(await changes(page)).filter((r) => r.field === 'favorite').map((r) => r.state)
		)
		.toEqual(['blocked']);
	env.reject(false);
	await dialog.getByRole('button', { name: 'Retry sync', exact: true }).click();
	await expect(dialog.getByText('DN could not apply your track changes.')).toHaveCount(0);
	await expect(
		dialog.getByRole('button', { name: 'Remove track from favorites', exact: true })
	).toHaveAttribute('aria-pressed', 'true');
	await expect
		.poll(async () =>
			(await changes(page)).filter((r) => r.field === 'favorite').map((r) => [r.value, r.state])
		)
		.toEqual([[true, 'confirmed']]);
	expect(env.writes.filter((r) => r.field === 'favorite')).toHaveLength(2);
});
