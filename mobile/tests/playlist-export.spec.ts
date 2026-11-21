import { chooseOption } from './fixtures/inlineChoice';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { localSignIn } from './fixtures/localSignIn';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import type { PlayerTrack } from '../src/lib/player';
import type { components } from '../../frontend/src/lib/api/v3/openapi';
const server = 'https://export.example/dn';
const b = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const dialog = (p: Page) => p.getByRole('dialog', { name: 'Export playlist' });
const csv =
	'title,artist,album,album artist,duration,path\r\n"=Rain","霧",B,A,15,Music/Rain.flac\r\n';
const m3u = '#EXTM3U\n#PLAYLIST:霧\n#EXTINF:15,A - Rain\nMusic/Rain.flac\n';
type ResponseMode = 'file' | 'hidden' | 'proxy' | 'expired' | 'missing' | 'html' | 'masquerade';
async function fixture(
	page: Page,
	owned = false,
	tracks: components['schemas']['PlaylistTrack'][] = []
) {
	let mode: ResponseMode = 'file';
	const exports: URL[] = [];
	const playlist = {
		id: 'road',
		name: 'Morning / mix',
		is_owner: owned,
		is_public: !owned,
		can_edit: owned,
		can_delete: owned,
		is_redacted: false,
		track_count: tracks.length,
		cover_urls: []
	};
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url()),
			path = url.pathname.slice('/dn/api/v3'.length);
		const json = (v: unknown, status = 200) => route.fulfill({ status, json: v });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture-' + req.postDataJSON().username });
		if (path === '/me')
			return json({
				id: req.headers().authorization?.slice('Bearer fixture-'.length),
				display_name: 'Listener',
				role: 'user'
			});
		if (path === '/playlists') return json({ playlists: [playlist] });
		if (path === '/playlists/road') return json({ ...playlist, tracks });
		if (path === '/playlists/road/export') {
			exports.push(url);
			expect(req.method()).toBe('GET');
			expect(req.headers().authorization).toMatch(/^Bearer fixture-/);
			if (mode === 'expired') return json({ error: { code: 'UNAUTHORIZED' } }, 401);
			if (mode === 'proxy')
				return route.fulfill({ status: 401, contentType: 'text/html', body: 'Sign in' });
			if (mode === 'missing') return json({ error: { code: 'NOT_FOUND' } }, 404);
			if (mode === 'html')
				return route.fulfill({ contentType: 'text/html', body: '<html>Gateway sign-in</html>' });
			const ext = url.searchParams.get('format'),
				head: Record<string, string> =
					mode === 'hidden'
						? {}
						: {
								'Content-Disposition':
									'attachment; filename="ASCII.' + ext + "\"; filename*=UTF-8''%E9%9C%A7." + ext,
								'X-DroppedNeedle-Skipped-Tracks': ext === 'csv' ? '2' : '0',
								'Access-Control-Expose-Headers':
									'Content-Disposition, X-DroppedNeedle-Skipped-Tracks'
							};
			return route.fulfill({
				headers: head,
				contentType: ext === 'csv' ? 'text/csv; charset=utf-8' : 'audio/x-mpegurl',
				body: mode === 'masquerade' ? '<html>Gateway</html>' : ext === 'csv' ? csv : m3u
			});
		}
		if (await emptyBoardRead(route)) return;
		return json({}, 404);
	});
	return { exports, set: (v: ResponseMode) => (mode = v) };
}
async function openPlaylist(page: Page, who = 'listener') {
	await localSignIn(page, server, who);
	await b(page, 'Search').click();
	await page
		.getByRole('group', { name: 'Search category' })
		.getByRole('button', { name: 'Playlists' })
		.click();
	await b(page, 'Morning / mix').click();
}
async function open(page: Page, who = 'listener') {
	await openPlaylist(page, who);
	await b(page, 'Export playlist').click();
}
async function fallback(page: Page) {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
	});
}
test('a touch picker expands inside its dialog and Back dismisses the choices first', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 650 });
	await fixture(page);
	await open(page);
	const sheet = dialog(page);
	const format = sheet.getByRole('combobox', { name: 'File format', exact: true });
	const prefix = sheet.getByLabel('Path prefix (optional)');
	const spacing = () => prefix.evaluate((el) => (el as HTMLElement).offsetTop);
	const before = await spacing();
	const accessibility = await page.context().newCDPSession(page);
	const tree = await accessibility.send('Accessibility.getFullAXTree');
	const accessible = tree.nodes.filter((node) => !node.ignored && node.role?.value === 'combobox');
	expect(accessible).toHaveLength(1);
	expect(accessible[0].name?.value).toBe('File format');
	expect(accessible[0].value?.value).toBe('M3U8 playlist');
	await accessibility.detach();
	await format.tap();
	const choices = sheet.getByRole('listbox', { name: 'File format', exact: true });
	await expect(choices).toBeVisible();
	await expect(format).toHaveAttribute('aria-expanded', 'true');
	const triggerBox = (await format.boundingBox())!;
	const listBox = (await choices.boundingBox())!;
	expect(
		listBox.y >= triggerBox.y + triggerBox.height - 1 ||
			listBox.y + listBox.height <= triggerBox.y + 1
	).toBeTruthy();
	expect(listBox.x + listBox.width).toBeLessThanOrEqual(320);
	expect(await spacing()).toBe(before);
	await expect(choices.getByRole('option', { name: 'M3U8 playlist' })).toHaveAttribute(
		'aria-selected',
		'true'
	);
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('dn-back', { cancelable: true })));
	await expect(choices).toHaveCount(0);
	await expect(format).toBeFocused();
	await format.press('ArrowDown');
	await format.press('End');
	await format.press('Escape');
	await expect(sheet).toBeVisible();
	await expect(choices).toHaveCount(0);
	await expect(format).toHaveText('M3U8 playlist');
	await format.press('Enter');
	await format.press('c');
	await format.press('Enter');
	await expect(format).toHaveText('CSV spreadsheet');
	await format.tap();
	await choices.getByRole('option', { name: 'M3U8 playlist' }).tap();
	await expect(format).toHaveText('M3U8 playlist');
	await format.press('End');
	await format.press('Tab');
	await expect(prefix).toBeFocused();
	await expect(format).toHaveText('CSV spreadsheet');
	await format.tap();
	await sheet.getByRole('heading').first().click();
	await expect(choices).toHaveCount(0);
	await format.tap();
	await sheet.getByRole('button', { name: 'Cancel' }).tap();
	await expect(sheet).toHaveCount(0);
});
test('a shared read-only listener downloads exact DN CSV and M3U8 with Unicode names and account-scoped prefixes', async ({
	page
}) => {
	await fallback(page);
	const api = await fixture(page);
	await open(page);
	await expect(b(page, 'Edit playlist')).toHaveCount(0);
	await chooseOption(dialog(page).getByLabel('File format'), 'csv');
	await dialog(page).getByLabel('Path prefix (optional)').fill('  Music/雨/  ');
	const download = page.waitForEvent('download');
	await b(page, 'Export file').click();
	const file = await download;
	expect(file.suggestedFilename()).toBe('霧.csv');
	expect(await readFile((await file.path())!, 'utf8')).toBe(csv);
	await expect(page.getByRole('status').filter({ hasText: '2 tracks skipped' })).toBeVisible();
	expect(api.exports[0].searchParams.get('prefix')).toBe('Music/雨/');
	await b(page, 'Export playlist').click();
	await expect(dialog(page).getByLabel('Path prefix (optional)')).toHaveValue('Music/雨/');
	await dialog(page).getByLabel('Path prefix (optional)').fill('');
	const second = page.waitForEvent('download');
	await b(page, 'Export file').click();
	expect(await readFile((await (await second).path())!, 'utf8')).toBe(m3u);
	expect(api.exports[1].searchParams.has('prefix')).toBe(false);
	await expect(page.getByRole('status').filter({ hasText: 'No tracks skipped.' })).toBeVisible();
	await b(page, 'Export playlist').click();
	await dialog(page).getByLabel('Path prefix (optional)').fill('Only this account/');
	const saved = page.waitForEvent('download');
	await b(page, 'Export file').click();
	await saved;
	await open(page, 'another');
	await expect(dialog(page).getByLabel('Path prefix (optional)')).toHaveValue('');
	api.set('hidden');
	const hidden = page.waitForEvent('download');
	await b(page, 'Export file').click();
	expect((await hidden).suggestedFilename()).toBe('Morning _ mix.m3u8');
	await expect(
		page.getByRole('status').filter({ hasText: 'skipped-track count is unavailable' })
	).toBeVisible();
});
test('browser picker cancellation and a failed write never report success; retry saves the selected file', async ({
	page
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: async (options: { suggestedName: string }) => {
				sessionStorage.setItem('suggested', options.suggestedName);
				if (sessionStorage.getItem('result') === 'cancel')
					throw new DOMException('Cancelled', 'AbortError');
				return {
					createWritable: async () => ({
						write: async (b: Blob) => {
							if (sessionStorage.getItem('result') === 'fail') throw Error('full');
							sessionStorage.setItem('body', await b.text());
						},
						close: async () => {},
						abort: async () => {
							sessionStorage.setItem('aborted', 'yes');
						}
					})
				};
			}
		});
	});
	const api = await fixture(page, true);
	await open(page);
	await expect(b(page, 'Edit playlist')).toBeVisible();
	await page.evaluate(() => sessionStorage.setItem('result', 'cancel'));
	await b(page, 'Export file').click();
	await b(page, 'Choose destination').click();
	await expect(dialog(page)).toHaveCount(0);
	await expect(page.getByText(/^Saved /)).toHaveCount(0);
	await b(page, 'Export playlist').click();
	await page.evaluate(() => sessionStorage.setItem('result', 'fail'));
	await b(page, 'Export file').click();
	await b(page, 'Choose destination').click();
	await expect(dialog(page).getByRole('alert')).toContainText('Could not finish writing');
	expect(await page.evaluate(() => sessionStorage.getItem('aborted'))).toBe('yes');
	await page.evaluate(() => sessionStorage.setItem('result', 'save'));
	await b(page, 'Export file').click();
	await b(page, 'Choose destination').click();
	await expect(page.getByRole('status').filter({ hasText: 'Saved 霧.m3u8' })).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('body'))).toBe(m3u);
	expect(api.exports).toHaveLength(3);
});
test('invalid prefix, HTML, denied access, lost network, and a truly expired DN account stay actionable', async ({
	page,
	context
}) => {
	await fallback(page);
	const api = await fixture(page);
	await open(page);
	await dialog(page).getByLabel('Path prefix (optional)').fill('M'.repeat(201));
	await b(page, 'Export file').click();
	await expect(dialog(page).getByRole('alert')).toContainText('up to 200');
	expect(api.exports).toHaveLength(0);
	await dialog(page).getByLabel('Path prefix (optional)').fill('');
	for (const [mode, message] of [
		['html', 'different file type'],
		['masquerade', 'sign-in page'],
		['missing', 'no longer shared'],
		['proxy', 'sign-in proxy']
	] as const) {
		api.set(mode);
		await b(page, 'Export file').click();
		await expect(dialog(page).getByRole('alert')).toContainText(message);
	}
	await context.setOffline(true);
	await b(page, 'Export file').click();
	await expect(dialog(page).getByRole('alert')).toContainText('Connect to DN');
	expect(api.exports).toHaveLength(4);
	await context.setOffline(false);
	api.set('expired');
	await b(page, 'Export file').click();
	await expect(page.getByLabel('Server address')).toBeVisible();
});

async function androidPlaylistBridge(page: Page) {
	await page.addInitScript(() => {
		const methods: Record<string, string[]> = {
			App: ['getLaunchUrl', 'addListener', 'removeListener'],
			Browser: ['open'],
			SecureStorage: ['internalGetItem', 'internalSetItem', 'internalRemoveItem'],
			CapacitorHttp: ['request', 'get'],
			DNOffline: [
				'options',
				'snapshot',
				'addListener',
				'removeListener',
				'historySettings',
				'cancelAutomatic'
			],
			DNPlayer: [
				'getState',
				'restore',
				'shuffleSelection',
				'setQueue',
				'addListener',
				'removeListener',
				'clearSession',
				'configure',
				'setFade',
				'setEqualizer',
				'setSession',
				'configureOfflineHistory'
			],
			DNPlaylistExport: ['prepare', 'save', 'discard']
		};
		const audit: {
			method: string;
			keys: string[];
			id: string;
			filename?: string;
			url?: string;
			authorized?: boolean;
		}[] = [];
		const secrets = new Map<string, string>();
		Object.assign(window, {
			androidBridge: {},
			Capacitor: {
				PluginHeaders: Object.entries(methods).map(([name, values]) => ({
					name,
					methods: values.map((name) => ({
						name,
						rtype: name === 'addListener' ? 'callback' : 'promise'
					}))
				})),
				nativeCallback: (_plugin: string, _method: string, opts: { eventName: string }) =>
					opts.eventName,
				nativePromise: async (
					plugin: string,
					method: string,
					opts: Record<string, string> = {}
				) => {
					if (plugin === 'SecureStorage') {
						if (method === 'internalSetItem') secrets.set(opts.prefixedKey, opts.data);
						if (method === 'internalRemoveItem') secrets.delete(opts.prefixedKey);
						return { data: secrets.get(opts.prefixedKey) ?? null, success: true };
					}
					if (plugin === 'DNOffline')
						return method === 'snapshot'
							? { items: [], options: { offlineOnly: false } }
							: { offlineOnly: false };
					if (plugin === 'DNPlayer') {
						if (method === 'shuffleSelection') {
							sessionStorage.setItem('shuffle-request', JSON.stringify(opts));
							return new Promise((resolve, reject) => {
								window.addEventListener(
									'finish-shuffle',
									(event) => {
										const reply = (event as CustomEvent<{ error?: string; indices?: number[] }>)
											.detail;
										if (reply.error) reject(Error(reply.error));
										else resolve({ indices: reply.indices });
									},
									{ once: true }
								);
							});
						}
						if (method === 'setQueue') {
							const tracks = opts.tracks as unknown as PlayerTrack[];
							const calls = JSON.parse(sessionStorage.getItem('submitted-queues') ?? '[]');
							sessionStorage.setItem(
								'submitted-queues',
								JSON.stringify([...calls, tracks.map((t) => t.title)])
							);
							sessionStorage.setItem('playing-tracks', JSON.stringify(tracks));
						}
						const tracks = JSON.parse(sessionStorage.getItem('playing-tracks') ?? '[]');
						return {
							tracks,
							index: tracks.length ? 0 : -1,
							position: 0,
							duration: 60,
							repeat: 'off',
							playing: !!tracks.length,
							error: null
						};
					}
					if (plugin === 'CapacitorHttp') {
						const response = await fetch(opts.url, {
							method: opts.method,
							headers: opts.headers as unknown as HeadersInit,
							body: opts.data ? JSON.stringify(opts.data) : undefined
						});
						return {
							data: await response.json(),
							headers: { 'Content-Type': 'application/json' },
							status: response.status
						};
					}
					if (plugin === 'DNPlaylistExport') {
						audit.push({
							method,
							id: opts.id,
							keys: Object.keys(opts).sort(),
							filename: opts.filename,
							url: opts.url,
							authorized: method === 'prepare' ? opts.token === 'fixture-listener' : undefined
						});
						sessionStorage.setItem('audit', JSON.stringify(audit));
						const mode = sessionStorage.getItem('native-result');
						if (method === 'prepare') {
							if (mode === 'expired')
								throw Object.assign(Error('Expired'), { code: 'DN_UNAUTHORIZED' });
							return {
								contentDisposition:
									"attachment; filename=Hint.csv; filename*=UTF-8''%C3%89t%C3%A9.csv",
								skippedTracks: '1'
							};
						}
						if (method === 'save') {
							if (mode === 'failed') throw Error('Choose a writable destination.');
							return { saved: mode !== 'cancel' };
						}
					}
					return {};
				}
			}
		});
	});
}

test('Android waits for the saved shuffle, maps repeated recordings by occurrence, and discards a superseded reply', async ({
	page
}) => {
	await androidPlaylistBridge(page);
	const titles = ['Opening cut', 'Interlude', 'Closing cut'];
	await fixture(
		page,
		true,
		titles.map((title, i) => ({
			id: 'entry-' + i,
			track_name: title,
			artist_name: 'Dawn',
			album_name: 'Road',
			source_type: 'local',
			track_source_id: i === 1 ? 'middle' : 'repeated',
			position: i,
			created_at: 1
		}))
	);
	await openPlaylist(page);
	const queues = () =>
		page.evaluate(() => JSON.parse(sessionStorage.getItem('submitted-queues') ?? '[]'));
	async function begin() {
		await page.evaluate(() => sessionStorage.removeItem('shuffle-request'));
		await b(page, 'Shuffle playlist').click();
		await expect
			.poll(() =>
				page.evaluate(() => JSON.parse(sessionStorage.getItem('shuffle-request') ?? 'null'))
			)
			.toEqual({
				serverUrl: server,
				userId: 'listener',
				ids: ['repeated', 'middle', 'repeated'],
				serverOrder: false
			});
	}
	async function reply(result: { error?: string; indices?: number[] }) {
		await page.evaluate(async (result) => {
			window.dispatchEvent(new CustomEvent('finish-shuffle', { detail: result }));
			await new Promise(requestAnimationFrame);
		}, result);
	}
	await begin();
	expect(await queues()).toEqual([]);
	await reply({ error: 'Could not save the shuffle order.' });
	await expect(
		page.getByRole('alert').filter({ hasText: 'Could not save the shuffle order.' })
	).toBeVisible();
	expect(await queues()).toEqual([]);

	await begin();
	await b(page, 'Play playlist').click();
	await expect(b(page, 'Show play queue')).toBeVisible();
	await reply({ indices: [2, 0, 1] });
	expect(await queues()).toEqual([titles]);
	await page.keyboard.press('Escape');
	await begin();
	await reply({ indices: [2, 0, 1] });
	await b(page, 'Show play queue').click();
	const expected = [titles[2], titles[0], titles[1]];
	await expect(page.locator('[data-part=play-queue] strong')).toHaveText(expected);
	expect(await queues()).toEqual([titles, expected]);
});

test('Android prepares via authenticated transport, passes only its handle and name to Files and cleans up after every result', async ({
	page
}) => {
	await androidPlaylistBridge(page);
	const fixtureServer = await fixture(page);
	await open(page);
	for (const mode of ['cancel', 'failed', 'save', 'expired']) {
		await page.evaluate((m) => sessionStorage.setItem('native-result', m), mode);
		await chooseOption(dialog(page).getByLabel('File format'), 'csv');
		await dialog(page).getByLabel('Path prefix (optional)').fill('Music/雨');
		await b(page, 'Export file').click();
		if (mode === 'cancel') await expect(dialog(page)).toHaveCount(0);
		else if (mode === 'failed') {
			await expect(dialog(page).getByRole('alert')).toContainText('writable destination');
			await b(page, 'Cancel').click();
		} else if (mode === 'save')
			await expect(
				page.getByRole('status').filter({ hasText: 'Saved Été.csv. 1 track skipped' })
			).toBeVisible();
		else {
			await expect(page.getByLabel('Server address')).toBeVisible();
			break;
		}
		await b(page, 'Export playlist').click();
	}
	const calls = await page.evaluate(
		() =>
			JSON.parse(sessionStorage.getItem('audit') ?? '[]') as {
				method: string;
				keys: string[];
				id: string;
				filename?: string;
				url?: string;
				authorized?: boolean;
			}[]
	);
	const started = calls.filter((c) => c.method === 'prepare'),
		saves = calls.filter((c) => c.method === 'save');
	expect(started).toHaveLength(4);
	expect(saves).toHaveLength(3);
	for (const c of started) {
		expect(c.authorized).toBe(true);
		expect(new URL(c.url!).pathname).toBe('/dn/api/v3/playlists/road/export');
		expect(new URL(c.url!).searchParams.get('prefix')).toBe('Music/雨');
		expect(calls.some((d) => d.method === 'discard' && d.id === c.id)).toBe(true);
	}
	for (const c of saves) {
		expect(c.keys).toEqual(['filename', 'id']);
		expect(c.filename).toBe('Été.csv');
	}
	expect(fixtureServer.exports).toHaveLength(0);
});

test('cancelling while DN prepares a file discards the response and a later export can succeed', async ({
	page
}) => {
	await fallback(page);
	const api = await fixture(page);
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	await page.route(
		server + '/api/v3/playlists/road/export?**',
		async (route) => {
			await gate;
			await route
				.fulfill({ status: 200, contentType: 'audio/x-mpegurl', body: m3u })
				.catch(() => {});
		},
		{ times: 1 }
	);
	await open(page);
	let downloads = 0;
	page.on('download', () => downloads++);
	const requesting = page.waitForRequest((r) => r.url().includes('/road/export?'));
	await b(page, 'Export file').click();
	await requesting;
	await b(page, 'Cancel').click();
	await expect(dialog(page)).toHaveCount(0);
	finish();
	await expect(page.getByText(/^(Saved |Download started)/)).toHaveCount(0);
	await b(page, 'Export playlist').click();
	const result = page.waitForEvent('download');
	await b(page, 'Export file').click();
	await result;
	await expect(page.getByRole('status').filter({ hasText: 'No tracks skipped.' })).toBeVisible();
	expect(downloads).toBe(1);
	expect(api.exports).toHaveLength(1);
});
