import { expect, test, type Page } from '@playwright/test';
import { localSignIn } from './fixtures/localSignIn';
import { emptyBoardRead } from './fixtures/emptyBoardRead';

const server = 'https://library.example/dn';

async function openPlaylists(page: Page, legacy = false) {
	const pressKeys: string[] = [];
	const imports: unknown[] = [];
	const writes: string[] = [];
	const states: Record<string, string> = {
		first: 'requestable',
		second: 'requestable',
		third: 'album_in_library',
		fourth: 'no_album_yet'
	};
	const summary = {
		id: 'weekend',
		name: 'Weekend',
		track_count: 4,
		can_edit: true,
		is_owner: true,
		is_redacted: false,
		cover_urls: [],
		updated_at: 1
	};
	const titles = ['First song', 'Second song', 'Missing bonus track', 'Unidentified song'];
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname.replace('/dn/api/v3', '');
		const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
		if (path === '/auth/providers')
			return json({ local: true, oidc: false, plex: false, jellyfin: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		if (path === '/me') return json({ id: 'listener', display_name: 'Listener' });
		if (path === '/playlists') return json({ playlists: [summary] });
		if (path === '/playlists/import') {
			imports.push(req.postDataJSON());
			return json({
				name: 'Road trip',
				playlist_id: 'new',
				matched: 1,
				kept: req.postDataJSON().library_only ? 0 : 2,
				unmatched: [],
				over_limit: 0
			});
		}
		if (path === '/playlists/weekend')
			return json({
				...summary,
				tracks: Object.keys(states).map((id, i) => ({
					id,
					track_name: titles[i],
					artist_name: 'Artist',
					album_name: 'Album',
					source_type: '',
					position: i,
					created_at: 1
				}))
			});
		if (path === '/playlists/weekend/request-state') {
			if (legacy) return json({}, 404);
			return json({
				entries: Object.entries(states).map(([entry_id, state]) => ({ entry_id, state })),
				requestable_albums: Object.values(states).filter((s) => s === 'requestable').length,
				no_album_songs: 1,
				finding_albums: false
			});
		}
		if (path === '/playlists/weekend/request-missing') {
			writes.push(path);
			const { idempotency_key, entry_id } = req.postDataJSON();
			pressKeys.push(idempotency_key);
			if (!entry_id && pressKeys.length === 1) return route.abort('connectionreset');
			states[entry_id || 'first'] = 'awaiting_approval';
			return json({
				requested: 1,
				needs_approval: true,
				in_library: 0,
				already_requested: 0,
				rejected_before: 0,
				over_quota: 0,
				over_cap: 0
			});
		}
		if (path === '/playlists/weekend/tracks/third/request-song') {
			writes.push(path);
			states.third = 'downloading';
			return json({ status: 'requested' });
		}
		if (await emptyBoardRead(route)) return;
		return json({}, 404);
	});
	await localSignIn(page, server);
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Playlists', exact: true }).click();
	return { pressKeys, imports, writes };
}

test('missing songs use DN statuses, retry the same bulk press, and request just one album or song', async ({
	page
}) => {
	const { pressKeys, writes } = await openPlaylists(page);
	await page.getByRole('button', { name: 'Weekend', exact: true }).click();
	await expect(page.getByText('Songs with no album found: 1')).toBeVisible();
	const bulk = page.getByRole('button', { name: 'Request missing albums (2)' });
	await bulk.click();
	await expect(page.getByRole('alert')).toBeVisible();
	await bulk.click();
	await expect(page.getByRole('status').filter({ hasText: 'Albums requested: 1' })).toBeVisible();
	expect(pressKeys).toHaveLength(2);
	expect(pressKeys[0]).toMatch(/^[a-f0-9-]{36}$/);
	expect(pressKeys[1]).toBe(pressKeys[0]);
	await expect(page.locator('[data-entry="first"]')).toContainText('Awaiting approval');
	await page.getByRole('button', { name: 'Request options for Second song' }).click();
	await page.getByRole('button', { name: 'Request album', exact: true }).click();
	await expect(page.locator('[data-entry="second"]')).toContainText('Awaiting approval');
	expect(pressKeys[2]).not.toBe(pressKeys[0]);
	await page.getByRole('button', { name: 'Request options for Missing bonus track' }).click();
	await expect(page.getByRole('button', { name: 'Request album', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Request just this song' }).click();
	await expect(page.locator('[data-entry="third"]')).toContainText('Downloading');
	expect(writes.at(-1)).toBe('/playlists/weekend/tracks/third/request-song');
	await expect(page.locator('[data-entry="fourth"]')).toContainText('No album found yet');
	await expect(
		page.getByRole('button', { name: 'Request options for Unidentified song' })
	).toHaveCount(0);
});

test('an older server keeps unavailable tracks visible without request controls or writes', async ({
	page
}) => {
	const { writes } = await openPlaylists(page, true);
	const response = page.waitForResponse((r) => r.url().endsWith('/request-state'));
	await page.getByRole('button', { name: 'Weekend', exact: true }).click();
	expect((await response).status()).toBe(404);
	await expect(page.getByText('First song', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: /Request (missing|options)/ })).toHaveCount(0);
	await expect(page.getByRole('alert')).toHaveCount(0);
	expect(writes).toEqual([]);
});

test('playlist import reports kept songs and only sends library-only when chosen', async ({
	page
}) => {
	const { imports } = await openPlaylists(page);
	for (const libraryOnly of [false, true]) {
		await page.getByRole('button', { name: 'Import playlist', exact: true }).click();
		const dialog = page.getByRole('dialog');
		await dialog.getByLabel('Playlist file').setInputFiles({
			name: 'Road trip.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from('Title,Artist\nSong,Artist')
		});
		const option = dialog.getByRole('checkbox', { name: 'Only songs already in the library' });
		await expect(option).not.toBeChecked();
		if (libraryOnly) await option.check();
		await dialog.getByRole('button', { name: 'Create from file' }).click();
		await expect(dialog).toHaveAccessibleName('Playlist imported');
		if (libraryOnly) await expect(dialog.getByText(/Songs kept to request/)).toHaveCount(0);
		else await expect(dialog.getByText('Songs kept to request: 2')).toBeVisible();
		await dialog.getByRole('button', { name: 'Done' }).click();
	}
	const body = { name: 'Road trip', format: 'csv', content: 'Title,Artist\nSong,Artist' };
	expect(imports).toEqual([body, { ...body, library_only: true }]);
});
