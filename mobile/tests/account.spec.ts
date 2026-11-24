import { chooseOption } from './fixtures/inlineChoice';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test, type Page } from '@playwright/test';

test('a listener can edit their DN profile, save visibility and revoke a different device', async ({
	page
}) => {
	const server = 'https://library.example/dn';
	let avatar = '';
	const avatarBytes = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
		'base64'
	);
	let display = 'Listener',
		visibility = 'offline',
		removed = false;
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			p = new URL(req.url()).pathname.slice('/dn/api/v3'.length);
		const json = (obj: unknown) => route.fulfill({ json: obj });
		if (p === '/me/section-prefs') return json({ pages: { home: [], discover: [] } });
		if (p === '/home') return json({ sections: [] });
		if (p === '/auth/providers') return json({ local: true, oidc: false });
		if (p === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (p === '/library/albums') return json({ items: [], next: null });
		if (p === '/me/avatar') {
			expect(req.method()).toBe('POST');
			expect(req.postDataJSON()).toEqual({
				content_type: 'image/png',
				image_base64: avatarBytes.toString('base64')
			});
			avatar = '/api/v3/users/demo/avatar?v=new';
			return json({ id: 'demo', role: 'user', display_name: display, avatar_url: avatar });
		}
		if (p === '/users/demo/avatar') {
			expect(new URL(req.url()).searchParams.get('v')).toBe('new');
			return route.fulfill({ contentType: 'image/png', body: avatarBytes });
		}
		if (p === '/me') {
			if (req.method() === 'PATCH') display = req.postDataJSON().display_name;
			return json({ id: 'demo', role: 'user', display_name: display, avatar_url: avatar || null });
		}
		if (p === '/me/scrobble-preferences') {
			if (req.method() === 'PUT') {
				expect(req.postDataJSON()).toEqual({ now_playing_visibility: 'track_hidden' });
				visibility = 'track_hidden';
			}
			return json({
				now_playing_visibility: visibility,
				scrobble_to_lastfm: false,
				scrobble_to_listenbrainz: true
			});
		}
		if (p === '/auth/sessions')
			return json({
				sessions: [
					{ id: 'current', label: 'Phone', current: true, last_seen_at: 1000 },
					...(removed
						? []
						: [{ id: 'old', label: 'Old tablet', current: false, last_seen_at: 1000 }])
				]
			});
		if (p === '/auth/sessions/old' && req.method() === 'DELETE') {
			removed = true;
			return route.fulfill({ status: 204 });
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected account operation ' + p);
	});
	await openAccount(page, server);
	await page
		.locator('input[type=file][accept*="image/gif"]')
		.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: avatarBytes });
	await expect(page.getByRole('img', { name: 'Profile photo' })).toBeVisible();
	await expect(page.getByText('Profile photo saved.')).toBeVisible();
	await page.getByRole('button', { name: 'Listening', exact: true }).click();
	await page.getByRole('button', { name: 'Profile', exact: true }).click();
	await expect(page.getByRole('img', { name: 'Profile photo' })).toBeVisible();

	await expect(page.getByText('Library health and scans')).toHaveCount(0);
	const newName = '🎵'.repeat(40);
	await page.getByLabel('Display name').fill('a'.repeat(65));
	await expect(page.getByRole('button', { name: 'Save name' })).toBeDisabled();
	await page.getByLabel('Display name').fill(newName);
	await page.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByRole('status')).toHaveText('Display name saved.');
	await page.getByRole('button', { name: 'Listening', exact: true }).click();
	await chooseOption(page.getByLabel('Now playing visibility'), 'track_hidden');
	await page.getByRole('button', { name: 'Save preferences' }).click();
	await expect(page.getByRole('status')).toHaveText('Listening preferences saved.');
	await page.getByRole('button', { name: 'Devices', exact: true }).click();
	await page.getByRole('button', { name: 'Sign out Old tablet' }).click();
	await page.getByRole('button', { name: 'Confirm sign out' }).click();
	await expect(page.getByText('Old tablet', { exact: true })).toHaveCount(0);
	expect(removed).toBeTruthy();
	expect(display).toBe(newName);
});

async function openAccount(page: Page, server: string) {
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('demo');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
	await page.getByRole('button', { name: 'Settings' }).click();
	await page.getByText('Account on DroppedNeedle', { exact: true }).click();
}

test('an administrator can inspect library health and confirm an incremental scan', async ({
	page
}) => {
	const server = 'https://library.example/dn';
	let started = false;
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			p = new URL(req.url()).pathname.slice('/dn/api/v3'.length);
		const json = (obj: unknown) => route.fulfill({ json: obj });
		if (p === '/me/section-prefs') return json({ pages: { home: [], discover: [] } });
		if (p === '/home') return json({ sections: [] });
		if (p === '/auth/providers') return json({ local: true, oidc: false });
		if (p === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (p === '/me') return json({ id: 'demo', role: 'admin', display_name: 'Demo' });
		if (p === '/library/albums') return json({ items: [], next: null });
		if (p === '/settings/library') return json({ enabled: true, policy_revision: 'revision-1' });
		if (p === '/library/stats')
			return json({ total_artists: 10, total_albums: 20, total_tracks: 100 });
		if (p === '/library/scan/runs/current')
			return json({ active: null, queued: started ? { state: 'queued' } : null });
		if (p === '/library/scan/runs/history') return json({ items: [], next: null });
		if (p === '/library/scan/runs' && req.method() === 'POST') {
			expect(req.postDataJSON()).toEqual({
				kind: 'incremental',
				scope_ids: [],
				expected_policy_revision: 'revision-1'
			});
			started = true;
			return json({ disposition: 'queued' });
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected admin operation ' + p);
	});
	await openAccount(page, server);
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name: 'Library health and scans', exact: true }).click();
	await expect(page.getByText('10 artists · 20 albums · 100 songs')).toBeVisible();
	await page.getByRole('button', { name: 'Scan for changes' }).click();
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	expect(started).toBeFalsy();
	await page.getByRole('button', { name: 'Scan for changes' }).click();
	await page.getByRole('button', { name: 'Start scan' }).click();
	await expect(page.getByRole('status')).toHaveText('Scan queued.');
	await expect(page.getByText('No scan running. A scan is queued.')).toBeVisible();
});

test('account identity, linked services and personal mix use the signed-in listener', async ({
	page
}) => {
	const server = 'https://library.example/dn';
	const user = {
		id: 'me',
		role: 'user',
		display_name: 'Test',
		username: 'test',
		email: '',
		username_display: 'test'
	};
	let refreshed = false;
	let prefs = {
		primary_music_source: 'listenbrainz',
		auto_request_personal_mix: false,
		navidrome_handles_external_scrobbles: false,
		now_playing_visibility: 'offline'
	};
	await page.route(server + '/api/v3/**', async (route) => {
		const r = route.request(),
			p = new URL(r.url()).pathname.slice('/dn/api/v3'.length),
			json = (v: unknown) => route.fulfill({ json: v });
		if (p === '/auth/providers') return json({ local: true, oidc: false });
		if (p === '/auth/login') return json({ token: 'account-fixture' });
		expect(r.headers().authorization).toBe('Bearer account-fixture');
		if (p === '/me') return json(user);
		if (p === '/me/username' && r.method() === 'PUT') {
			user.username_display = user.username = r.postDataJSON().username;
			return json(user);
		}
		if (p === '/me/email' && r.method() === 'PUT') {
			user.email = r.postDataJSON().email;
			return json(user);
		}
		if (p === '/me/section-prefs') return json({ pages: { home: [], discover: [] } });
		if (p === '/library/albums') return json({ items: [], next: null });
		if (p === '/home') return json({ sections: [] });
		if (p === '/me/connections')
			return json({
				connections: [{ service: 'lastfm', username: 'fixture-handle', enabled: true }]
			});
		if (p === '/requests/personal-mix/refresh' && r.method() === 'POST') {
			refreshed = true;
			return json({ status: 'already_running' });
		}
		if (p === '/me/scrobble-preferences') {
			if (r.method() === 'PUT') {
				expect(r.postDataJSON()).toEqual({
					primary_music_source: 'lastfm',
					auto_request_personal_mix: true,
					navidrome_handles_external_scrobbles: true
				});
				prefs = { ...prefs, ...r.postDataJSON() };
			}
			return json(prefs);
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected account operation ' + p);
	});
	await openAccount(page, server);
	await page.getByText('Username and email', { exact: true }).click();
	await page.getByRole('textbox', { name: 'Username', exact: true }).fill('listener');
	await page.getByRole('button', { name: 'Save username' }).click();
	await expect(page.getByRole('status')).toHaveText('Username saved.');
	await page.getByLabel('Email', { exact: true }).fill('listener@example.test');
	await page.getByRole('button', { name: 'Save email' }).click();
	await expect(page.getByRole('status')).toHaveText('Email saved.');
	expect(user.username).toBe('listener');
	expect(user.email).toBe('listener@example.test');
	await page.getByRole('button', { name: 'Services', exact: true }).click();
	await expect(page.getByText('fixture-handle · Enabled')).toBeVisible();
	await page.getByRole('button', { name: 'Listening', exact: true }).click();
	await chooseOption(page.getByLabel('Discovery listening source'), 'lastfm');
	await page.getByLabel('Automatically request my personal mix').check();
	await page.getByLabel('Let Navidrome forward its own scrobbles').check();
	await page.getByRole('button', { name: 'Save preferences' }).click();
	await expect(page.getByRole('status')).toHaveText('Listening preferences saved.');
	await page.getByRole('button', { name: 'Refresh personal mix' }).click();
	await expect(page.getByRole('status')).toHaveText('A mix refresh is already running.');
	expect(refreshed).toBe(true);
});

for (const older of [false, true]) {
	test(
		'Discover history controls on ' +
			(older ? 'an older server' : 'an account with a linked import'),
		async ({ page }) => {
			const server = 'https://history.example/dn';
			let state = 'current',
				deletes = 0,
				imports = 0,
				reads = 0,
				refuse = true;
			await page.route(server + '/api/v3/**', async (route) => {
				const req = route.request(),
					path = new URL(req.url()).pathname.split('/api/v3/')[1];
				const json = (data: unknown) => route.fulfill({ json: data });
				if (path === 'auth/providers') return json({ local: true, oidc: false });
				if (path === 'auth/login') return json({ token: 'history-token' });
				expect(req.headers().authorization).toBe('Bearer history-token');
				if (path === 'me') return json({ id: 'listener', role: 'user', display_name: 'Listener' });
				if (path === 'me/scrobble-preferences') return json({ now_playing_visibility: 'offline' });
				if (path === 'me/connections')
					return json({
						connections: [{ service: 'listenbrainz', username: 'demo', enabled: true }]
					});
				const status = () => ({
					plays: 24,
					imported_listens: state === 'current' ? 12 : 0,
					state,
					account: 'demo'
				});
				if (path === 'me/listening-history') {
					reads++;
					return older ? route.fulfill({ status: 404 }) : json(status());
				}
				if (path === 'me/listening-history/import') {
					expect(req.method()).toBe('POST');
					imports++;
					state = 'pending';
					return route.fulfill({ status: 202, json: status() });
				}
				if (path === 'discover/history') {
					expect(req.method()).toBe('DELETE');
					deletes++;
					if (refuse)
						return route.fulfill({ status: 403, json: { error: { message: 'Access denied' } } });
					state = 'forgotten';
					return route.fulfill({ status: 204 });
				}
				if (await emptyBoardRead(route)) return;
				return route.fulfill({ status: 404 });
			});
			await openAccount(page, server);
			const button = (name: string) => page.getByRole('button', { name, exact: true });
			await button('Listening').click();
			expect(reads).toBe(0);
			await button('Discover history').click();
			if (older) {
				await expect(
					page.getByText('This DroppedNeedle version does not share Discover history controls.')
				).toBeVisible();
				await expect(button('Forget Discover history')).toHaveCount(0);
				await expect(button('Save preferences')).toBeVisible();
				return;
			}
			await expect(page.getByText('Imported listens from ListenBrainz · 12')).toBeVisible();
			await expect(button('Upload a ListenBrainz ZIP in DroppedNeedle')).toBeVisible();
			await button('Forget Discover history').click();
			await button('Cancel').click();
			expect(deletes).toBe(0);
			await button('Forget Discover history').click();
			await button('Confirm forget history').click();
			await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Access denied');
			refuse = false;
			await button('Confirm forget history').click();
			await expect(page.getByText('Discover history forgotten.')).toBeVisible();
			await expect(page.getByText('Plays in DroppedNeedle · 24')).toBeVisible();
			await expect(page.getByText('Imported listens from ListenBrainz · 0')).toBeVisible();
			expect(imports).toBe(0);
			await button('Import again from ListenBrainz').click();
			await expect(page.getByText('Import in progress.')).toBeVisible();
			expect(imports).toBe(1);
			state = 'current';
			await button('Refresh history status').click();
			await expect(page.getByText('Imported listens from ListenBrainz · 12')).toBeVisible();
			await page.evaluate(() => localStorage.setItem('dn.mobile.language.v1', 'ja'));
			await page.reload();
			await page.getByLabel(/^(サーバーアドレス|Server address)$/).fill(server);
			await page.getByRole('button', { name: /^(続ける|Continue)$/ }).click();
			await page.getByLabel(/^(ユーザー名|Username)$/).fill('demo');
			await page.getByLabel(/^(パスワード|Password)$/).fill('fixture');
			await page.getByRole('button', { name: /^(サインイン|Sign in)$/ }).click();
			await expect(page.getByRole('heading', { name: 'ホーム', exact: true })).toBeVisible();
			await button('設定').click();
			await page.getByText('DroppedNeedle のアカウント', { exact: true }).click();
			await button('リスニング').click();
			await button('おすすめ履歴').click();
			await expect(page.getByText('ListenBrainzから取り込んだ再生履歴 · 12')).toBeVisible();
			await button('おすすめ履歴を削除').click();
			await expect(
				page.getByRole('dialog', { name: 'おすすめ履歴を削除しますか？' })
			).toBeVisible();
		}
	);
}
