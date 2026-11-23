import { chooseOption } from './fixtures/inlineChoice';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test, type Page } from '@playwright/test';

const oldKey = 'dn.mobile.appearance.v1';
const legacy = {
	version: 1,
	name: 'Quiet',
	corners: 0,
	spacing: 20,
	typeface: 'serif',
	colors: {
		bg: '#131c20',
		surface: '#1b272c',
		raised: '#26373e',
		text: '#f3f6f1',
		muted: '#adbfbd',
		accent: '#b5ebc5',
		'on-accent': '#11251b',
		line: '#52645f'
	}
};

async function settings(page: Page) {
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Themes', exact: true }).click();
}

test('DN Dark, Light and Midnight use the web palettes; System tracks the device after restart', async ({
	page
}) => {
	await page.goto('/');
	const root = page.locator('html');
	await expect(root).toHaveAttribute('data-theme', 'dark');
	await settings(page);
	const palettes = [
		[
			'Dark',
			'dark',
			'#090e0b',
			'#121913',
			'#263128',
			'#bac9b8',
			'#f6f3e8',
			'#b8ef64',
			'#b8ef64',
			'#ff837a'
		],
		[
			'Light',
			'light',
			'#f6f3e8',
			'#fffdf5',
			'#e7eddf',
			'#3f5649',
			'#fffdf5',
			'#1e6a38',
			'#b8ef64',
			'#a32628'
		],
		[
			'Midnight',
			'midnight',
			'#090e0b',
			'#0b0f0c',
			'#2c3a2f',
			'#a9b8a8',
			'#222d24',
			'#b8ef64',
			'#b8ef64',
			'#ff837a'
		]
	];
	for (const [name, mode, bg, surface, raised, muted, paper, accent, action, error] of palettes) {
		await page.getByRole('button', { name, exact: true }).click();
		await expect(root).toHaveAttribute('data-theme', mode);
		for (const [key, value] of Object.entries({
			'--bg': bg,
			'--surface': surface,
			'--raised': raised,
			'--muted': muted,
			'--dn-paper': paper,
			'--accent': accent,
			'--dn-action': action,
			'--color-error': error
		})) {
			await expect(root).toHaveCSS(key, value);
		}
		await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', bg);
	}
	await page.emulateMedia({ colorScheme: 'light' });
	await page.getByRole('button', { name: 'System', exact: true }).click();
	await expect(root).toHaveAttribute('data-theme', 'light');
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(root).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await page.emulateMedia({ colorScheme: 'light' });
	await expect(root).toHaveAttribute('data-theme', 'light');
	await settings(page);
	await expect(page.getByRole('button', { name: 'System', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('an existing custom theme survives upgrade, switching presets, invalid imports and restart', async ({
	page
}) => {
	await page.goto('/');
	await page.evaluate(
		({ oldKey, legacy }) => localStorage.setItem(oldKey, JSON.stringify(legacy)),
		{ oldKey, legacy }
	);
	await page.reload();
	const root = page.locator('html');
	await expect(root).toHaveCSS('--bg', legacy.colors.bg);
	await expect(root).toHaveCSS('--gap', '20px');
	await settings(page);
	await page.getByRole('button', { name: 'Light', exact: true }).click();
	await page.getByRole('button', { name: 'Use custom theme Quiet' }).click();
	await page.getByText('Edit or share theme').click();
	const editor = page.getByLabel('Theme JSON');
	expect(JSON.parse(await editor.inputValue())).toEqual(legacy);
	const updated = { ...legacy, name: 'Reading', corners: 7 };
	await editor.fill(JSON.stringify(updated));
	await page.getByRole('button', { name: 'Apply theme', exact: true }).click();
	await expect(root).toHaveCSS('--radius', '7px');
	await editor.fill(
		JSON.stringify({
			...updated,
			colors: { ...updated.colors, bg: 'url(https://invalid.example)' }
		})
	);
	await page.getByRole('button', { name: 'Apply theme', exact: true }).click();
	await expect(page.getByRole('alert')).toBeVisible();
	await page.reload();
	await settings(page);
	await page.getByText('Edit or share theme').click();
	expect(JSON.parse(await editor.inputValue())).toEqual(updated);
	await expect(root).toHaveCSS('--dn-action', updated.colors.accent);
});

test('follows the DN theme, writes only a chosen mode and preserves a device override', async ({
	page
}) => {
	const server = 'https://themes.example/music';
	let mode = 'midnight',
		fail = false;
	const writes: unknown[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			path = new URL(req.url()).pathname.slice('/music/api/v3'.length);
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (path === '/me') return json({ id: 'user', role: 'user', display_name: 'Listener' });
		if (path === '/home') return json({ sections: [] });
		if (path === '/me/section-prefs') return json({ pages: {} });
		if (path === '/library/albums')
			return json({
				items: [{ id: 'first', title: 'Night Press', artist_name: 'Listener', art_missing: true }],
				next: null,
				total: 1
			});
		if (path === '/library/albums/match/first')
			return json({
				items: [
					{
						id: 'cut-one',
						title: 'Night Press A',
						album_title: 'Night Press',
						artist_name: 'Listener',
						disc_number: 1,
						track_number: 1,
						art_missing: true
					}
				],
				total: 1
			});
		if (path === '/me/appearance') {
			if (fail)
				return route.fulfill({
					status: 503,
					json: { error: { code: 'UNAVAILABLE', message: 'Appearance unavailable.' } }
				});
			if (req.method() === 'PUT') {
				const body = req.postDataJSON();
				writes.push(body);
				mode = body.theme;
			}
			return json({
				theme: mode,
				custom_css: { css: 'body {color: red}' },
				site: {},
				stored: true
			});
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected fixture route ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username', { exact: true }).fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
	await settings(page);
	const root = page.locator('html');
	await expect(page.getByText('Account theme: Midnight.')).toBeVisible();
	await expect(root).toHaveAttribute('data-theme', 'midnight');
	await expect(page.getByLabel('Follow account theme')).toBeChecked();
	expect(writes).toEqual([]);
	await page.getByRole('button', { name: 'Light', exact: true }).click();
	await expect(page.getByText('Account theme: Light.')).toBeVisible();
	await expect.poll(() => writes).toEqual([{ theme: 'light' }]);
	mode = 'dark';
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(root).toHaveAttribute('data-theme', 'dark');
	await page.getByLabel('Follow account theme').uncheck();
	await page.getByRole('button', { name: 'Midnight', exact: true }).click();
	mode = 'light';
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect(root).toHaveAttribute('data-theme', 'midnight');
	await expect(page.getByText('Account theme: Light.')).toBeVisible();
	expect(writes).toEqual([{ theme: 'light' }]);
	fail = true;
	await page.getByRole('button', { name: 'Dark', exact: true }).click();
	await page.getByRole('button', { name: 'Save device theme to account' }).click();
	await expect(page.getByText('Appearance unavailable.')).toBeVisible();
	await expect(root).toHaveAttribute('data-theme', 'dark');
	expect(mode).toBe('light');
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name: 'Night Press Listener' }).click();
	const sheet = page.locator('[data-part="track-list"]');
	await expect(sheet).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(sheet).toHaveCSS('--muted', '#bac9b8');
	await settings(page);
	await page.getByRole('button', { name: 'Midnight', exact: true }).click();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(sheet).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(sheet).toHaveCSS('--muted', '#a9b8a8');
});

test('preview and import only supported account CSS colors from a current or historical DN style', async ({
	page
}) => {
	const server = 'https://palette.example/dn',
		requests: string[] = [],
		foreign: string[] = [];
	const current = `@import url("https://unused.example/theme.css");
 :root, [data-theme] { --color-primary: #abc; --dn-muted: oklch(50% 0 0); --dn-action: rgb(120 40 140); --radius-box: 0.5rem; --color-error: url(https://unused.example/ignore); }
 [data-theme='light'] { --color-primary: rgb(12 34 56) !important; }
 :root {--color-primary: #ffeedd;}
 [data-theme='dark'] { --color-primary: #010203; }
 .web-only { font-family: never; background: url(https://unused.example/image); }`;
	await page.route('https://unused.example/**', (r) => {
		foreign.push(r.request().url());
		return r.abort();
	});
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			p = new URL(req.url()).pathname.slice('/dn/api/v3'.length);
		const json = (data: unknown) => route.fulfill({ json: data });
		if (p === '/auth/providers') return json({ local: true, oidc: false });
		if (p === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (p === '/me') return json({ id: 'listener', role: 'user', display_name: 'Listener' });
		if (p === '/home') return json({ sections: [] });
		if (p === '/me/section-prefs') return json({ pages: {} });
		if (p === '/library/albums') return json({ items: [], next: null, total: 0 });
		if (p === '/me/appearance' || p === '/me/appearance/css-saves') {
			expect(req.method()).toBe('GET');
			requests.push(p);
			return json(
				p.endsWith('css-saves')
					? [
							{
								id: 7,
								saved_at: 1764054000000,
								css: ':root {--dn-title: #4a7; --color-success: #116644}'
							},
							{ id: 8, saved_at: 1764055000000, css: 'main button { text-indent: 1px }' }
						]
					: { theme: 'light', custom_css: { text: current, enabled: true }, stored: true, site: {} }
			);
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected palette fixture endpoint ' + p);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username', { exact: true }).fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
	await settings(page);
	await expect(page.getByText('Account theme: Light.')).toBeVisible();
	expect(requests).toEqual(['/me/appearance']);
	await page.getByText('Import colors from a web style', { exact: true }).click();
	const panel = page
		.locator('details')
		.filter({ has: page.getByText('Import colors from a web style', { exact: true }) });
	await expect(panel.getByText('4 compatible variables in the Light palette.')).toBeVisible();
	await expect(panel.getByText('.web-only', { exact: true })).toBeVisible();
	await expect(panel.getByText('@import', { exact: true })).toBeVisible();
	await expect(panel.getByText('--color-error (unsupported value)', { exact: true })).toBeVisible();
	await expect(
		panel.getByText('Rules for other themes were excluded from this palette.')
	).toBeVisible();
	const root = page.locator('html');
	await expect(root).toHaveCSS('--accent', '#1e6a38');
	await panel.getByRole('button', { name: 'Apply palette to this device' }).click();
	await expect(root).toHaveCSS('--accent', '#0c2238');
	await expect(root).toHaveCSS('--dn-action', '#78288c');
	await expect(root).toHaveCSS('--radius', '8px');
	await expect(root).toHaveCSS('--muted', '#636363');
	await chooseOption(panel.getByLabel('Web style'), '8');
	await expect(panel.getByText('No compatible palette variables found.')).toBeVisible();
	await expect(panel.getByRole('button', { name: 'Apply palette to this device' })).toHaveCount(0);
	await chooseOption(panel.getByLabel('Web style'), '7');
	await chooseOption(panel.getByLabel('Palette to import'), 'midnight');
	await expect(panel.getByText('2 compatible variables in the Midnight palette.')).toBeVisible();
	await panel.getByRole('button', { name: 'Apply palette to this device' }).click();
	await expect(root).toHaveCSS('--color-success', '#116644');
	await expect(root).toHaveCSS('--heading', '#44aa77');
	expect(requests).toEqual(['/me/appearance', '/me/appearance/css-saves']);
	expect(foreign).toEqual([]);
	await page.reload();
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username', { exact: true }).fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(root).toHaveCSS('--color-success', '#116644');
	await expect(root).toHaveCSS('--heading', '#44aa77');
});

test('settings search matches both languages, respects sign-in and remembers the device language', async ({
	page
}) => {
	await page.goto('/');
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const search = page.getByRole('searchbox', { name: 'Search settings' });
	await search.fill('イコライザー');
	await expect(page.getByText('No matching settings.')).toBeVisible();
	await search.fill('language');
	await page.getByRole('button', { name: 'App language', exact: true }).click();
	await chooseOption(page.getByRole('combobox', { name: 'App language' }), 'ja');
	await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
	await expect(page.getByRole('heading', { name: 'アプリの言語' })).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading', { name: 'サーバーに接続' })).toBeVisible();
	await page.getByRole('button', { name: '設定', exact: true }).click();
	await page.getByRole('searchbox', { name: '設定を検索' }).fill('mini-player');
	await expect(page.getByRole('button', { name: 'ミニプレーヤー' })).toHaveCount(0);
	await page.getByRole('searchbox', { name: '設定を検索' }).fill('Navigation bar');
	await page.getByRole('button', { name: 'ナビゲーションバー', exact: true }).click();
	await expect(
		page.getByRole('heading', { name: 'ナビゲーションバー', exact: true })
	).toBeInViewport();
});
