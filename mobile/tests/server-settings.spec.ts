import { choiceList, chooseOption } from './fixtures/inlineChoice';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const server = 'https://dn.example/music';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function setup(page: Page, role: 'user' | 'admin') {
	const pref = (key: string, enabled = true, available = true) => ({
		key,
		title: key,
		enabled,
		available,
		turned_off: false,
		zone: 'music',
		description: ''
	});
	const pages = {
		home: [pref('History'), pref('Other'), pref('Offline', true, false)],
		discover: [pref('Top picks')],
		sidebar: []
	};
	let edition = {
		date: 'earliest',
		version: 'standard',
		format_order: ['vinyl', 'shellac, special'],
		status_order: ['official'],
		countries: ['JP'],
		avoid_types: ['live'],
		manage_unconfirmed: false
	};
	let types = { primary_types: ['album'], secondary_types: ['studio'] };
	const writes: string[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			p = new URL(req.url()).pathname.slice('/music/api/v3'.length),
			json = (v: unknown) => route.fulfill({ json: v });
		if (p === '/auth/providers') return json({ local: true, oidc: false });
		if (p === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (p === '/me') return json({ id: 'listener', display_name: 'Listener', role });
		if (p === '/home') return json({ sections: [] });
		if (p === '/library/albums') return json({ items: [], next: null });
		if (p === '/me/section-prefs') {
			if (req.method() === 'PUT') {
				const body = req.postDataJSON();
				expect(body.page).toBe('home');
				expect(body.sections).toEqual([
					{ key: 'History', enabled: false },
					{ key: 'Other', enabled: false },
					{ key: 'Offline', enabled: true }
				]);
				pages.home[0].enabled = false;
				writes.push(p);
			}
			return json({ pages });
		}
		if (p === '/settings/edition-preferences') {
			if (req.method() === 'PUT') {
				edition = req.postDataJSON();
				writes.push(p);
			}
			return json(edition);
		}
		if (p === '/settings/preferences') {
			if (req.method() === 'PUT') {
				types = req.postDataJSON();
				writes.push(p);
			}
			return json(types);
		}
		if (p === '/library/stats')
			return json({
				total_artists: 2,
				total_albums: 3,
				total_tracks: 24,
				total_size_bytes: 1073741824,
				favorite_artists: 1,
				favorite_albums: 2,
				favorite_tracks: 3,
				format_breakdown: { FLAC: 24 }
			});
		if (p === '/admin/queue-stats' && role === 'admin')
			return json({ queues: [{ kind: 'identify', queued: 3, running: 1, failed: 0 }], jobs: [] });
		if (p === '/admin/provider-stats' && role === 'admin') return json({ calls: [], limiters: [] });
		if (p === '/version') return json({ version: 'test-server' });
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected settings route ' + p);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await button(page, 'Continue').click();
	await page.getByLabel('Username').fill('test');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await button(page, 'Sign in').click();
	await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
	await button(page, 'Settings').click();
	return { pages, getEdition: () => edition, getTypes: () => types, writes };
}
test('listener changes server content visibility while preserving concurrent edits and unavailable sections', async ({
	page
}) => {
	const { pages, writes } = await setup(page, 'user');
	await expect(button(page, 'Server diagnostics')).toHaveCount(0);
	await button(page, 'Library statistics').click();
	await expect(page.getByText('FLAC', { exact: true })).toBeVisible();
	await expect(page.getByText('1 GiB', { exact: true })).toBeVisible();
	await button(page, 'Back').click();
	await button(page, 'Account-wide content visibility').click();
	await expect(page.getByLabel('Offline')).toBeDisabled();
	await page.getByLabel('History').uncheck();
	pages.home[1].enabled = false;
	await button(page, 'Save section preferences').click();
	await expect(page.getByRole('status')).toHaveText('Section preferences saved.');
	await expect(page.getByLabel('Other')).not.toBeChecked();
	await expect((await choiceList(page.getByLabel('Page'))).getByRole('option')).toHaveCount(2);
	await button(page, 'Back').click();
	await expect(button(page, 'Edition preferences')).toHaveCount(0);
	await button(page, 'Open in DN web app').click();
	await expect(page.getByRole('link', { name: 'Backups' })).toHaveCount(0);
	await expect(page.getByRole('link')).toHaveCount(0);
	await page.getByText('Content preferences', { exact: true }).click();
	await expect(page.getByRole('link', { name: 'Discover', exact: true })).toHaveAttribute(
		'href',
		server + '/settings?tab=discover'
	);
	await page.getByText('Your account', { exact: true }).click();
	await expect(page.getByRole('link', { name: 'Account security and avatar' })).toHaveAttribute(
		'href',
		server + '/profile#account'
	);
	expect(writes).toEqual(['/me/section-prefs']);
});
test('admin edits release and edition preferences and can open each deployed web settings tab', async ({
	page
}) => {
	const state = await setup(page, 'admin');
	await button(page, 'Server diagnostics').click();
	await expect(page.getByText('3 queued · 1 running · 0 failed')).toBeVisible();
	await button(page, 'Back').click();
	await button(page, 'Edition preferences').click();
	await expect(page.getByRole('textbox')).toHaveCount(0);
	await expect(page.getByRole('searchbox')).toHaveCount(0);
	await expect(button(page, 'Save server preferences')).toBeDisabled();
	await button(page, 'Add country').click();
	await page.getByRole('searchbox', { name: 'Find a country' }).fill('not a code');
	await expect(page.getByText('No available choices match.')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(button(page, 'Add country')).toBeFocused();
	await expect(page.getByRole('searchbox')).toHaveCount(0);
	await button(page, 'Add country').click();
	await page.getByRole('searchbox', { name: 'Find a country' }).fill('gb');
	await button(page, 'United Kingdom (GB)').click();
	await button(page, 'Move United Kingdom (GB) up').click();
	await button(page, 'Add format').click();
	await page.getByRole('searchbox', { name: 'Find a format' }).fill('cd');
	await button(page, 'CD').click();
	await button(page, 'Remove Vinyl').click();
	await button(page, 'Add format').click();
	await page.getByRole('searchbox', { name: 'Find a format' }).fill('Shellac, Mono');
	await button(page, 'Use custom value “shellac, mono”').click();
	await button(page, 'Add release status').click();
	await button(page, 'Bootleg').click();
	await button(page, 'Move Bootleg up').click();
	state.getEdition().avoid_types.push('demo');
	await button(page, 'Save server preferences').click();
	await expect(page.getByRole('status')).toHaveText('Server preferences saved.');
	expect(state.getEdition()).toMatchObject({
		countries: ['GB', 'JP'],
		format_order: ['shellac, special', 'cd', 'shellac, mono'],
		status_order: ['bootleg', 'official'],
		avoid_types: ['live', 'demo'],
		version: 'standard'
	});
	await button(page, 'Back').click();
	await button(page, 'Release types').click();
	await page.getByLabel('EP', { exact: true }).check();
	state.getTypes().primary_types.push('single');
	await button(page, 'Save server preferences').click();
	await expect(page.getByRole('status')).toHaveText('Server preferences saved.');
	expect(state.getTypes().primary_types).toEqual(['album', 'single', 'ep']);
	await button(page, 'Back').click();
	await button(page, 'Open in DN web app').click();
	await expect(page.getByRole('link')).toHaveCount(0);
	const summaries = page.locator('details.settings-disclosure > summary');
	await expect(summaries).toHaveCount(5);
	for (const summary of await summaries.all()) await summary.click();
	const web = readFileSync(
		new URL('../../frontend/src/routes/settings/+page.svelte', import.meta.url),
		'utf8'
	);
	const tabs = [
		...web
			.split('const tabs = [')[1]
			.split('].filter')[0]
			.matchAll(/\bid:\s*'([^']+)'/g)
	].map((m) => m[1]);
	const urls = await page
		.getByRole('link')
		.evaluateAll((links) => links.map((a) => a.getAttribute('href')));
	expect(tabs.length).toBeGreaterThan(25);
	for (const id of tabs) expect(urls).toContain(server + '/settings?tab=' + id);
	await page.getByText('System', { exact: true }).click();
	await expect(page.getByRole('link', { name: 'Backups' })).toHaveCount(0);
	await page.getByLabel('Find a web tool').fill('バックアップ');
	await expect(page.getByRole('link')).toHaveCount(1);
	await expect(page.getByRole('link', { name: 'Backups' })).toHaveAttribute(
		'href',
		server + '/settings?tab=backups'
	);
	await page.getByLabel('Find a web tool').fill('');
	await expect(page.getByRole('link', { name: 'Backups' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Manage artists' })).toBeVisible();
	await button(page, 'Back').click();
	await button(page, 'Open in DN web app').click();
	await expect(page.getByRole('link')).toHaveCount(0);
	await button(page, 'Back').click();
	await button(page, 'About').click();
	await expect(page.getByText('test-server', { exact: true })).toBeVisible();
});

test('Japanese edition pickers and web disclosures use local labels and accept either search language', async ({
	page
}) => {
	await setup(page, 'admin');
	await button(page, 'App language').click();
	await chooseOption(page.getByRole('combobox', { name: 'App language' }), 'ja');
	await button(page, '戻る').click();
	await button(page, 'エディションの設定').click();
	await expect(page.getByRole('heading', { name: '国・地域' })).toBeVisible();
	await expect(page.getByText('日本 (JP)', { exact: true })).toBeVisible();
	await button(page, '国を追加').click();
	await page.getByRole('searchbox', { name: '国を検索' }).fill('アメリカ');
	await expect(page.getByRole('button', { name: /アメリカ.*\(US\)/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await button(page, '戻る').click();
	await button(page, 'DN のウェブアプリで開く').click();
	await expect(page.getByRole('link')).toHaveCount(0);
	const system = page.getByText('システム', { exact: true });
	await system.focus();
	await page.keyboard.press('Enter');
	const backups = page.getByRole('link', { name: 'バックアップ', exact: true });
	await expect(backups).toBeVisible();
	await page.keyboard.press('Enter');
	await expect(backups).toHaveCount(0);
	await page.getByRole('searchbox', { name: 'ウェブツールを検索' }).fill('Backups');
	await expect(backups).toHaveAttribute('href', server + '/settings?tab=backups');
});
