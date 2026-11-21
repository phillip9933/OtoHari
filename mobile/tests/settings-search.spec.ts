import { expect, test } from '@playwright/test';
import { findSettings } from '../src/lib/appearance/settingsSearch';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';

test('settings search opens the named control and reveals sign out without changing the session', async ({
	page
}) => {
	const server = 'https://settings-search.example';
	await page.route(server + '/api/v3/**', async (route) => {
		const path = new URL(route.request().url()).pathname.slice('/api/v3'.length);
		const responses: Record<string, unknown> = {
			'/auth/providers': { local: true, oidc: false },
			'/auth/login': { token: 'fixture' },
			'/me': { id: 'listener', role: 'user', display_name: 'Listener' },
			'/playback/conversion': { conversion: 'off' }
		};
		if (Object.hasOwn(responses, path)) return route.fulfill({ json: responses[path] });
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected settings request ' + path);
	});
	await localSignIn(page, server);
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	await button('Settings').click();
	const settingsGroup = (name: string) =>
		page.getByRole('heading', { name, exact: true }).locator('+ .settings-list');
	await expect(
		settingsGroup('Appearance & layout').getByRole('button', { name: 'Home layout' })
	).toBeVisible();
	await expect(
		settingsGroup('Playback').getByRole('button', { name: 'Track fades' })
	).toBeVisible();
	await expect(
		settingsGroup('Downloads & storage').getByRole('button', { name: 'Device storage' })
	).toBeVisible();
	await expect(
		settingsGroup('Account').getByRole('button', { name: 'Account-wide content visibility' })
	).toBeVisible();
	await expect(
		settingsGroup('Library').getByRole('button', { name: 'Library statistics' })
	).toBeVisible();
	await expect(settingsGroup('App').getByRole('button', { name: 'App language' })).toBeVisible();
	const search = page.getByRole('searchbox', { name: 'Search settings' });
	for (const [term, label, breadcrumb, anchor] of [
		['wifi', 'Wi-Fi stream quality', 'Playback → Streaming quality', 'stream-wifi'],
		['playback speed', 'Playback speed', 'Playback → Sound', 'playback-speed'],
		[
			'offline mode',
			'Offline mode',
			'Downloads & storage → Offline mode and playback cache',
			'offline-mode'
		]
	]) {
		await search.fill(term);
		const result = button(label);
		await expect(result.locator('small')).toHaveText(breadcrumb);
		await result.click();
		await expect(page.locator('#' + anchor)).toBeFocused();
		await button('Back').click();
	}
	await search.fill('logout');
	await expect(button('Sign out').locator('small')).toHaveText('Account');
	await button('Sign out').click();
	await expect(page.locator('#account-sign-out')).toBeFocused();
	await expect(search).toHaveValue('');
	await button('Back').click();
	await expect(search).toHaveValue('logout');
	await expect(button('Sign out').locator('small')).toHaveText('Account');
	await expect(page.getByRole('navigation', { name: 'Navigation shortcuts' })).toBeVisible();
});

test('former setting names point to available controls with their current breadcrumbs', () => {
	const device = {
		signedIn: true,
		account: true,
		admin: false,
		android: true,
		ios: false,
		offline: true
	};
	const results = (query: string, access = device) => findSettings(query, access);
	expect(results('Wi-Fi')).toEqual(results('Ｗｉ‑Ｆｉ'));
	expect(results('wifi')[0].anchor).toBe('stream-wifi');
	expect(results('complete downloads')).toEqual([
		expect.objectContaining({
			page: 'downloads',
			label: 'Include artwork, lyrics & waveforms',
			anchor: 'complete-downloads'
		})
	]);
	expect(results('キューの先読み').map((hit) => hit.anchor)).toContain('queue-read-ahead');
	expect(results('queue and autoplay')[0]).toMatchObject({
		page: 'menu',
		anchor: 'queue-autoplay',
		breadcrumb: ['Playback']
	});
	expect(results('diagnostic report')[0].breadcrumb).toEqual(['App', 'Troubleshooting']);
	expect(results('Server diagnostics')).toEqual([]);
	expect(results('Server diagnostics', { ...device, admin: true })[0].page).toBe('diagnostics');
	expect(results('sign out', { ...device, signedIn: false, account: false })).toEqual([]);
	expect(results('playback speed', { ...device, signedIn: false, account: false })).toEqual([]);
	expect(results('queue read-ahead', { ...device, android: false })).toEqual([]);
});
