import { minimizePlayer } from './fixtures/minimizePlayer';
import { chooseOption } from './fixtures/inlineChoice';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { silentWav } from './fixtures/silentWav';
import { seedOfflineMusic } from './fixtures/offlineMusic';

declare global {
	interface Window {
		fixtureVolumes: number[];
		transitionSamples: {
			time: number;
			left: number;
			right: number;
			nextTime: number;
			two: boolean;
		}[];
		transitionPosition: () => number;
		liveDecks: () => number;
		setFixtureConnection: (transport: string) => void;
	}
}

const server = 'https://playback.example/collection';
const original = fileURLToPath(
	new URL('../../server/tests/fixtures/library/management_full.wav', import.meta.url)
);
const converted = fileURLToPath(
	new URL('../../server/tests/fixtures/library/management_full.opus', import.meta.url)
);

async function network(page: Page, legacy = false) {
	await page.addInitScript(
		({ server, legacy }) => {
			const connection = Object.assign(new EventTarget(), { type: 'wifi' });
			Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
			window.setFixtureConnection = (transport) => {
				connection.type = transport;
				connection.dispatchEvent(new Event('change'));
			};
			if (legacy)
				localStorage.setItem(
					'dn.mobile.stream.v1.' + JSON.stringify([server, 'listener']),
					JSON.stringify({ format: 'opus', rate: 192 })
				);
		},
		{ server, legacy }
	);
}
async function connect(
	page: Page,
	secondTrack = false,
	firstResponse?: Promise<void>,
	longAudio = false,
	account = 'listener',
	edges?: { head: number; tail: number; album: boolean; pulse?: number }
) {
	const streams: string[] = [];
	let conversion = 'on';
	await page.route(server + '/api/v3/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname.slice('/collection/api/v3'.length);
		const json = (value: unknown) => route.fulfill({ json: value });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture-device' });
		expect(route.request().headers().authorization).toBe('Bearer fixture-device');
		if (path === '/me') return json({ id: account, display_name: 'Listener', role: 'user' });
		if (path === '/playback/conversion') return json({ conversion });
		if (path === '/library/albums')
			return json({
				items: [{ id: 'a', title: 'Nightfall', artist_name: 'Strings', art_missing: true }],
				next: null
			});
		if (path === '/library/albums/match/a') {
			const items = (secondTrack ? ['first', 'next'] : ['first']).map((id, i) => ({
				id,
				title: i ? 'Overtones' : 'Reflections',
				artist_name: 'Strings',
				album_title: 'Nightfall',
				duration_seconds: edges ? 6 : 0.3,
				disc_number: 1,
				track_number: edges && !edges.album && i ? 4 : i + 1
			}));
			return json({ items, total: items.length });
		}
		if (path === '/stream/local/first' || path === '/stream/local/next') {
			streams.push(url.search);
			if (path.endsWith('first') && firstResponse) await firstResponse;
			if (edges) {
				const wav = silentWav(6);
				const first = path.endsWith('first');
				for (let i = 0; i < 6 * 8000; i++) {
					const t = i / 8000,
						quiet = first ? t >= 6 - edges.tail : t < edges.head;
					let amplitude = quiet ? 400 : 11000;
					if (edges.pulse) {
						const beat = Math.floor(i / 800) % (first ? 5 : edges.pulse) === (first ? 1 : 2);
						amplitude = beat ? 18000 : 5500;
					}
					wav.writeInt16LE(
						Math.round(Math.sin(t * Math.PI * (first ? 440 : 660)) * amplitude),
						44 + i * 2
					);
				}
				return route.fulfill({ body: wav, contentType: 'audio/wav' });
			}
			if (longAudio) return route.fulfill({ body: silentWav(60), contentType: 'audio/wav' });
			const format = url.searchParams.get('format');
			if (format === 'mp3')
				return route.fulfill({
					path: fileURLToPath(
						new URL('../../server/tests/fixtures/library/management_full.mp3', import.meta.url)
					),
					contentType: 'audio/mpeg'
				});
			return route.fulfill({
				path: format === 'opus' ? converted : original,
				contentType: format === 'opus' ? 'audio/ogg' : 'audio/wav'
			});
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected request ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill(account);
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	return {
		streams,
		disableConversion: () => {
			conversion = 'off';
		}
	};
}
async function settings(page: Page, section: string) {
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: section, exact: true }).click();
}
async function back(page: Page, heading: string) {
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
}

test('playback speed persists and applies to the playing audio element', async ({ page }) => {
	await page.addInitScript(() => {
		const Original = window.Audio;
		window.Audio = class extends Original {
			constructor(src?: string) {
				super(src);
				Object.defineProperty(window, 'speedTestDeck', { value: this, configurable: true });
			}
		};
	});
	await connect(page, true, undefined, true);
	await settings(page, 'Sound');
	await chooseOption(page.getByRole('combobox', { name: 'Playback speed' }), '1.5');
	await expect(page.getByRole('combobox', { name: 'Playback speed' })).toHaveAttribute(
		'data-value',
		'1.5'
	);
	await back(page, 'Settings');
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page
		.getByRole('button', { name: /Nightfall/ })
		.first()
		.click();
	await page.getByRole('button', { name: 'Play album', exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => Reflect.get(window, 'speedTestDeck')?.playbackRate))
		.toBe(1.5);
});

async function swipe(touch: CDPSession, x: number, y: number, dx: number, dy: number) {
	await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
	for (let i = 1; i <= 5; i++) {
		await touch.send('Input.dispatchTouchEvent', {
			type: 'touchMove',
			touchPoints: [{ x: x + (dx * i) / 5, y: y + (dy * i) / 5 }]
		});
	}
	await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('compact player controls fit at 320px and return from the real queue to the invoking button', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 700 });
	await connect(page, true, undefined, true);
	await page
		.getByRole('button', { name: /Nightfall/ })
		.first()
		.click();
	await page.getByRole('button', { name: 'Play album', exact: true }).click();
	const now = page.getByRole('region', { name: 'Now playing' });
	await minimizePlayer(page);
	const mini = page.getByRole('region', { name: 'Current track' });
	const dock = page.getByRole('navigation', { name: 'Music' });
	await expect(mini).toHaveCSS('box-shadow', 'none');
	await expect(dock).toHaveCSS('box-shadow', 'none');
	await expect(dock).toHaveCSS('border-top-width', '1px');
	await expect(mini.getByRole('button')).toHaveCount(3);
	await expect(mini.getByText('Strings', { exact: true })).toBeVisible();
	await expect(mini.locator('[data-part=cover]')).toBeVisible();
	await expect(mini.getByRole('progressbar')).toHaveCount(0);
	const defaultHeight = await mini.evaluate((el) => el.clientHeight);
	await settings(page, 'Mini-player');
	const form = page.getByRole('group', { name: 'Mini-player' });
	await chooseOption(form.getByLabel('Secondary text'), 'artist-album');
	await form.getByLabel('Show track progress').check();
	await chooseOption(form.getByLabel('Before Play/Pause'), 'next');
	await expect(form.getByLabel('After Play/Pause')).toHaveAttribute('data-value', 'none');
	await chooseOption(form.getByLabel('After Play/Pause'), 'queue');
	await back(page, 'Settings');
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(mini.getByText('Strings · Nightfall', { exact: true })).toBeVisible();
	await expect(mini.getByRole('progressbar', { name: 'Track progress' })).toBeVisible();
	await expect
		.poll(() => mini.getByRole('progressbar').evaluate((el) => (el as HTMLProgressElement).value))
		.toBeGreaterThan(0);
	await expect(mini.getByRole('button')).toHaveCount(4);
	expect(
		await mini.evaluate((el) => ({
			height: el.clientHeight,
			overflows: el.scrollWidth > el.clientWidth
		}))
	).toEqual({ height: defaultHeight, overflows: false });
	const boxes = await mini.getByRole('button').evaluateAll((els) =>
		els.map((e) => {
			const { left, right, width, height } = e.getBoundingClientRect();
			return { left, right, width, height };
		})
	);
	expect(boxes.every((b) => b.left >= 0 && b.right <= 320 && b.width >= 44 && b.height >= 44)).toBe(
		true
	);
	await mini.getByRole('button', { name: 'Next track' }).click();
	const open = mini.getByRole('button', { name: 'Open player for Overtones' });
	await expect(open).toBeVisible();
	await expect(mini.getByRole('button', { name: 'Next track' })).toBeDisabled();
	await mini.getByRole('button', { name: 'Pause', exact: true }).click();
	const queue = mini.getByRole('button', { name: 'Open play queue', exact: true });
	await queue.focus();
	await page.keyboard.press('Enter');
	await expect(now.getByRole('heading', { name: 'Play queue' })).toBeVisible();
	await expect(now.getByText('Reflections', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(queue).toBeFocused();
	await open.click();
	await now.getByRole('button', { name: 'Show play queue', exact: true }).click();
	await page.keyboard.press('Escape');
	await expect(now).toBeVisible();
	await expect(now.getByRole('heading', { name: 'Play queue' })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(open).toBeFocused();
	await expect(open).toHaveCSS('outline-width', '3px');
	await settings(page, 'Mini-player');
	await chooseOption(form.getByLabel('Secondary text'), 'album');
	await chooseOption(form.getByLabel('Before Play/Pause'), 'previous');
	await back(page, 'Settings');
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(open).toHaveAccessibleDescription('Nightfall');
	await mini.getByRole('button', { name: 'Previous track' }).click();
	await expect(mini.getByRole('button', { name: 'Open player for Reflections' })).toBeVisible();
	await settings(page, 'Mini-player');
	await page.getByRole('button', { name: 'Restore mini-player defaults' }).click();
	await expect(form.getByLabel('Before Play/Pause')).toHaveAttribute('data-value', 'none');
	await expect(form.getByLabel('After Play/Pause')).toHaveAttribute('data-value', 'next');
	await expect(form.getByLabel('Show track progress')).not.toBeChecked();
});

test('compact player settings follow the listener, persist after sign-in, and control saved music offline', async ({
	page
}) => {
	await connect(page);
	await settings(page, 'Mini-player');
	const form = page.getByRole('group', { name: 'Mini-player' });
	await form.getByLabel('Show cover artwork').uncheck();
	await chooseOption(form.getByLabel('Secondary text'), 'hidden');
	await chooseOption(form.getByLabel('After Play/Pause'), 'none');
	await connect(page, false, undefined, false, 'second-listener');
	await settings(page, 'Mini-player');
	await expect(form.getByLabel('Show cover artwork')).toBeChecked();
	await expect(form.getByLabel('Secondary text')).toHaveAttribute('data-value', 'artist');
	await expect(form.getByLabel('After Play/Pause')).toHaveAttribute('data-value', 'next');
	const fixture = await connect(page);
	await settings(page, 'Mini-player');
	await expect(form.getByLabel('Show cover artwork')).not.toBeChecked();
	await expect(form.getByLabel('Secondary text')).toHaveAttribute('data-value', 'hidden');
	await expect(form.getByLabel('After Play/Pause')).toHaveAttribute('data-value', 'none');
	await back(page, 'Settings');
	await back(page, 'Home');
	await seedOfflineMusic(page, server, 'listener', true, [
		{
			origin: 'downloaded',
			track: {
				id: 'saved',
				title: 'On device',
				artist: 'Saved artist',
				album: 'Saved album',
				streamUrl: '/api/v3/stream/local/saved',
				duration: 3
			}
		}
	]);
	await page.context().setOffline(true);
	await page.getByRole('button', { name: 'Library', exact: true }).click();
	await page.getByRole('button', { name: 'Offline music', exact: true }).click();
	await page
		.getByRole('region', { name: 'Offline music' })
		.getByRole('button', { name: /On device Saved artist/ })
		.click();
	const now = page.getByRole('region', { name: 'Now playing' });
	await now.getByRole('button', { name: 'Pause', exact: true }).click();
	await minimizePlayer(page);
	const mini = page.getByRole('region', { name: 'Current track' });
	await expect(mini.getByRole('button')).toHaveCount(2);
	await expect(mini.getByRole('button', { name: 'Open player for On device' })).toBeVisible();
	await expect(mini.locator('[data-part=cover]')).toHaveCount(0);
	await expect(mini.getByText('Saved artist', { exact: true })).toHaveCount(0);
	await mini.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(mini.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
	expect(fixture.streams).toEqual([]);
});

test('navigation precedes settings and its shortcuts fit at phone widths and large text sizes', async ({
	page
}) => {
	await connect(page);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const root = page.locator('[data-part=settings]');
	const menu = root.getByRole('navigation', { name: 'Navigation shortcuts' });
	await expect(root.getByRole('heading', { level: 1 })).toHaveText('Navigation');
	await expect(menu.locator('xpath=following-sibling::h2[1]')).toHaveText('Settings');
	await expect(menu.getByRole('button')).toHaveCount(5);
	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 844 });
		for (const scale of [100, 200]) {
			await page.evaluate((size) => (document.documentElement.style.fontSize = size + '%'), scale);
			const clipped = await menu.locator('button span').evaluateAll((labels) =>
				labels.flatMap((label) => {
					const text = document.createRange();
					text.selectNodeContents(label);
					const box = label.closest('button')!.getBoundingClientRect();
					const glyphs = text.getBoundingClientRect();
					return text.getClientRects().length === 1 &&
						glyphs.left >= box.left &&
						glyphs.right <= box.right &&
						box.left >= 0 &&
						box.right <= document.documentElement.clientWidth
						? []
						: [label.textContent];
				})
			);
			expect(clipped, width + 'px and ' + scale + '% text').toEqual([]);
		}
	}
});

test('the Settings shortcuts keep every destination reachable when the dock is empty', async ({
	page
}) => {
	await connect(page);
	await settings(page, 'Button style and transitions');
	await page.getByRole('button', { name: 'Blur', exact: true }).click();
	await page.getByRole('slider', { name: 'Blur strength' }).fill('19');
	await chooseOption(page.getByLabel('Screen transitions'), 'gentle');
	await back(page, 'Settings');
	await page.getByRole('button', { name: 'Navigation bar and start screen', exact: true }).click();
	await page.getByRole('button', { name: 'Floating', exact: true }).click();
	await page.getByRole('button', { name: 'Move Library earlier' }).click();
	await page.getByRole('checkbox', { name: 'Discover', exact: true }).uncheck();
	await back(page, 'Settings');
	await back(page, 'Home');
	const nav = page.getByRole('navigation', { name: 'Music' });
	await expect(nav.getByRole('button').first()).toHaveText('Library');
	await expect(nav).toHaveCSS('backdrop-filter', 'blur(19px)');
	await expect(page.locator('footer')).toHaveCSS('position', 'absolute');
	const toggle = page.getByRole('button', { name: 'Settings', exact: true });
	await toggle.click();
	const menu = page.getByRole('navigation', { name: 'Navigation shortcuts' });
	await menu.getByRole('button', { name: 'Discover', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Discover', exact: true })).toBeVisible();
	await toggle.click();
	await page.getByRole('button', { name: 'Navigation bar and start screen' }).click();
	for (const id of ['Library', 'Home', 'Search', 'Requests'])
		await page.getByRole('checkbox', { name: id, exact: true }).uncheck();
	await back(page, 'Settings');
	await back(page, 'Discover');
	await expect(nav).toHaveCount(0);
	await toggle.click();
	await expect(menu.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(menu).toHaveCount(0);
	await expect(toggle).toBeFocused();
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-navigation', 'floating');
	await expect(page.locator('html')).toHaveAttribute('data-material', 'blur');
	await expect(page.locator('html')).toHaveAttribute('data-motion', 'gentle');
});

test('an existing blur preference carries over and all three materials paint the real controls', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dn.mobile.interface.v1',
			JSON.stringify({ surface: 'glass', blur: 21, bar: 'floating', motion: 'off' })
		);
	});
	await connect(page);
	await settings(page, 'Button style and transitions');
	const style = page.getByRole('group', { name: 'Surface style' });
	const control = page.getByRole('button', { name: 'Restore style defaults' });
	const panel = page.locator('#interface-motion');
	await expect(style.getByRole('button', { name: 'Blur', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(control).toHaveCSS('backdrop-filter', 'blur(21px)');
	await expect(panel).toHaveCSS('backdrop-filter', 'blur(21px)');
	await style.getByRole('button', { name: 'Glass', exact: true }).click();
	await expect(control).toHaveCSS('backdrop-filter', 'none');
	await expect(panel).toHaveCSS('background-image', /linear-gradient\(145deg/);
	await style.getByRole('button', { name: 'Solid Theme Color' }).click();
	await expect(panel).toHaveCSS('background-image', 'none');
	await expect(control).toHaveCSS('background-image', 'none');
	await style.getByRole('button', { name: 'Glass', exact: true }).click();
	await control.click();
	await expect(style.getByRole('button', { name: 'Solid Theme Color' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-material', 'solid');
	await expect(page.locator('html')).toHaveAttribute('data-navigation', 'floating');
});

test('the Home header opens Settings at the right and direct dock shortcuts open their Library category', async ({
	page
}) => {
	await connect(page);
	const b = (name: string) => page.getByRole('button', { name, exact: true });
	const nav = page.getByRole('navigation', { name: 'Music' }),
		header = page.getByRole('banner');
	const logo = header.getByRole('img', { name: 'OtoHari' });
	await expect(logo).toBeVisible();
	expect((await logo.boundingBox())!.width).toBeGreaterThan(44);
	expect((await b('Settings').boundingBox())!.x).toBeGreaterThan(page.viewportSize()!.width / 2);
	await expect(b('Select items')).toHaveCount(0);
	const touch = await page.context().newCDPSession(page);
	await swipe(touch, 7, 145, 105, 8);
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await settings(page, 'Navigation bar and start screen');
	for (const name of ['Discover', 'Requests'])
		await page.getByRole('checkbox', { name, exact: true }).uncheck();
	for (const name of ['Albums', 'Settings'])
		await page.getByRole('checkbox', { name, exact: true }).check();
	await nav.getByRole('button', { name: 'Albums', exact: true }).click();
	await expect(header.getByRole('heading', { name: 'Albums', exact: true })).toBeVisible();
	await expect(nav.getByRole('button', { name: 'Albums' })).toHaveAttribute('aria-current', 'page');
	await expect(header.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
	await expect(header.getByRole('button', { name: 'Collection options' })).toHaveCount(0);
	await expect(b('Collection options')).toBeVisible();
	await b('Back to Library').click();
	await expect(nav.getByRole('button', { name: 'Library' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await b('Offline music').click();
	await expect(page.getByRole('heading', { name: 'Offline music', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
	await nav.getByRole('button', { name: 'Settings' }).click();
	await expect(nav.getByRole('button', { name: 'Settings' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await page
		.getByRole('navigation', { name: 'Navigation shortcuts' })
		.getByRole('button', { name: 'Home' })
		.click();
	await expect(header.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
	await touch.detach();
});

test('artwork and mini-player horizontal swipes change tracks while taps still open the player', async ({
	page
}) => {
	await connect(page, true, undefined, true);
	await page
		.getByRole('button', { name: /Nightfall/ })
		.first()
		.click();
	await page.getByRole('button', { name: 'Play album', exact: true }).click();
	const now = page.getByRole('region', { name: 'Now playing' });
	const mini = page.getByRole('region', { name: 'Current track' });
	const touch = await page.context().newCDPSession(page);
	const art = now.locator('[data-section-id="player-artwork"] [data-part=cover]');
	await art.scrollIntoViewIfNeeded();
	const box = (await art.boundingBox())!;
	await swipe(touch, box.x + box.width * 0.65, box.y + box.height / 2, -85, 4);
	await expect(now.getByText('Overtones', { exact: true }).first()).toBeVisible();
	await minimizePlayer(page);
	const openMini = mini.getByRole('button', { name: 'Open player for Overtones' });
	const b = (await openMini.boundingBox())!;
	await swipe(touch, b.x + b.width * 0.3, b.y + b.height / 2, 97, 4);
	await expect(mini.getByRole('button', { name: 'Open player for Reflections' })).toBeVisible();
	await expect(now).toHaveCount(0);
	await mini.getByRole('button', { name: 'Open player for Reflections' }).tap();
	await expect(now.getByText('Reflections', { exact: true }).first()).toBeVisible();
	await touch.detach();
});

test('a rejected streaming setting keeps its saved choice and accepts a retry', async ({
	page
}) => {
	await connect(page);
	await settings(page, 'Streaming quality');
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key.startsWith('dn.mobile.stream.')) {
				Storage.prototype.setItem = original;
				throw Error('Could not write streaming preferences');
			}
			original.call(this, key, value);
		};
	});
	const format = page.getByRole('combobox', { name: 'Wi-Fi audio format' });
	await chooseOption(format, 'opus');
	await expect(page.getByRole('alert')).toContainText('Could not write streaming preferences');
	await expect(format).toHaveText('Original file');
	await expect(format).toBeEnabled();
	await chooseOption(format, 'mp3');
	await expect(format).toHaveText('MP3');
	await expect(page.getByRole('combobox', { name: 'Wi-Fi requested bitrate' })).toBeEnabled();
});

test('DN conversion and local fades apply to playback through the normal album action', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem('dn.mobile.track-fades.v1', '2000');
		const audio = window.Audio;
		const volumes: number[] = [];
		Object.assign(window, {
			fixtureVolumes: volumes,
			Audio: new Proxy(audio, {
				construct(target, args) {
					const element = Reflect.construct(target, args) as HTMLAudioElement;
					element.addEventListener('volumechange', () => volumes.push(element.volume));
					return element;
				}
			})
		});
	});
	await network(page);
	const fixture = await connect(page);
	async function play() {
		await page
			.getByRole('button', { name: /Nightfall/ })
			.first()
			.click();
		await page.getByRole('button', { name: 'Play album', exact: true }).click();
		await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();
		await minimizePlayer(page);
		await expect(page.getByRole('navigation', { name: 'Music' })).toBeVisible();
	}
	await play();
	expect(fixture.streams).toEqual(['']);
	await settings(page, 'Streaming quality');
	await expect(page.getByText(/DN can convert streams/)).toBeVisible();
	await chooseOption(page.getByLabel('Wi-Fi audio format'), 'opus');
	await chooseOption(page.getByLabel('Wi-Fi requested bitrate'), '128');
	await back(page, 'Settings');
	await page.getByRole('button', { name: 'Track fades', exact: true }).click();
	await expect(page.getByRole('combobox', { name: 'Fade in', exact: true })).toHaveAttribute(
		'data-value',
		'2000'
	);
	await expect(page.getByRole('combobox', { name: 'Fade out', exact: true })).toHaveAttribute(
		'data-value',
		'2000'
	);
	await expect(page.getByRole('checkbox', { name: 'Smart fades' })).not.toBeChecked();
	const fallbacks = page.getByRole('group', { name: 'Fallback fades', exact: true });
	await expect(fallbacks).toHaveCount(0);
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (key === 'dn.mobile.track-fades.v2') {
				Storage.prototype.setItem = original;
				throw Error('Could not save fades');
			}
			original.call(this, key, value);
		};
	});
	await page.getByRole('checkbox', { name: 'Smart fades' }).click();
	await expect(page.getByRole('alert')).toContainText('Could not save fades');
	await expect(page.getByRole('checkbox', { name: 'Smart fades' })).not.toBeChecked();
	await page.getByRole('checkbox', { name: 'Smart fades' }).check();
	await expect(fallbacks).toBeVisible();
	await chooseOption(fallbacks.getByLabel('Fade in', { exact: true }), '500');
	await chooseOption(fallbacks.getByLabel('Fade out', { exact: true }), '4000');
	await back(page, 'Settings');
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'Music' })
		.getByRole('button', { name: 'Home', exact: true })
		.click();
	await play();
	expect(fixture.streams).toEqual(['', '?format=opus&max_bitrate=128']);
	await expect
		.poll(() => page.evaluate(() => window.fixtureVolumes.some((v) => v < 0.1)))
		.toBe(true);
	fixture.disableConversion();
	await settings(page, 'Streaming quality');
	await expect(page.getByText(/Conversion is turned off/)).toBeVisible();
	await expect(page.getByLabel('Wi-Fi audio format')).toHaveAttribute('data-value', 'opus');
	await expect(page.getByLabel('Cellular data audio format')).toHaveAttribute(
		'data-value',
		'original'
	);
	await chooseOption(page.getByLabel('Wi-Fi audio format'), 'original');
	await back(page, 'Settings');
	await page.getByRole('button', { name: 'Track fades', exact: true }).click();
	await expect(page.getByLabel('Fade in', { exact: true })).toHaveAttribute('data-value', '500');
	await expect(page.getByRole('checkbox', { name: 'Smart fades' })).toBeChecked();
	await expect(page.getByLabel('Fade out', { exact: true })).toHaveAttribute('data-value', '4000');
	await page.getByRole('checkbox', { name: 'Smart fades' }).uncheck();
	await expect(fallbacks).toHaveCount(0);
	await expect(page.getByLabel('Fade out', { exact: true })).toHaveAttribute('data-value', '4000');
});

test('a queued track uses the new network profile without interrupting the track that was loading', async ({
	page
}) => {
	await network(page, true);
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const fixture = await connect(page, true, gate);
	await settings(page, 'Streaming quality');
	await expect(page.getByLabel('Wi-Fi audio format')).toHaveAttribute('data-value', 'opus');
	await expect(page.getByLabel('Cellular data audio format')).toHaveAttribute('data-value', 'opus');
	await chooseOption(page.getByLabel('Cellular data audio format'), 'mp3');
	await chooseOption(page.getByLabel('Cellular data requested bitrate'), '96');
	await expect(page.getByLabel('Wi-Fi requested bitrate')).toHaveAttribute('data-value', '192');
	await back(page, 'Settings');
	await back(page, 'Home');
	await page
		.getByRole('button', { name: /Nightfall/ })
		.first()
		.click();
	await page.getByRole('button', { name: 'Play album', exact: true }).click();
	try {
		await expect.poll(() => fixture.streams).toEqual(['?format=opus&max_bitrate=192']);
		await page.evaluate(() => window.setFixtureConnection('cellular'));
	} finally {
		release();
	}
	await expect
		.poll(() => fixture.streams)
		.toEqual(['?format=opus&max_bitrate=192', '?format=mp3&max_bitrate=96']);
	await minimizePlayer(page);
	await settings(page, 'Streaming quality');
	await expect(page.getByText('Connected through cellular data.')).toBeVisible();
	await page.evaluate(() => window.setFixtureConnection('wifi'));
	await expect(page.getByText('Connected through Wi-Fi or Ethernet.')).toBeVisible();
	await expect(page.getByLabel('Cellular data requested bitrate')).toHaveAttribute(
		'data-value',
		'96'
	);
});

for (const example of [
	{ name: 'quiet ending and intro', tail: 1.4, head: 1, album: false, expected: 2.4 },
	{ name: 'matching rhythmic edges', tail: 0, head: 0, album: false, pulse: 5, expected: 2.1 },
	{ name: 'different rhythmic tempos', tail: 0, head: 0, album: false, pulse: 7, expected: 0 },
	{ name: 'two loud edges', tail: 0, head: 0, album: false, expected: 0 },
	{ name: 'consecutive album tracks', tail: 1.4, head: 1, album: true, expected: 0 }
]) {
	test('Smart fades play ' + example.name + ' through the real queue', async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem(
				'dn.mobile.track-fades.v2',
				JSON.stringify({ fadeInMs: 500, fadeOutMs: 2000, smart: true })
			);
			const elements: HTMLAudioElement[] = [];
			const samples: {
				time: number;
				left: number;
				right: number;
				nextTime: number;
				two: boolean;
			}[] = [];
			Object.assign(window, {
				transitionSamples: samples,
				transitionPosition: () => elements.find((a) => !a.paused && a.currentSrc)?.currentTime ?? 0,
				Audio: new Proxy(window.Audio, {
					construct(target, args) {
						const element = Reflect.construct(target, args) as HTMLAudioElement;
						elements.push(element);
						return element;
					}
				})
			});
			setInterval(() => {
				const [first, second] = elements.filter((el) => el.currentSrc.startsWith('blob:'));
				if (first && second && !first.paused)
					samples.push({
						time: first.currentTime,
						left: first.volume,
						right: second.volume,
						nextTime: second.currentTime,
						two: !second.paused
					});
			}, 30);
		});
		const fixture = await connect(page, true, undefined, false, 'listener', example);
		await page
			.getByRole('button', { name: /Nightfall/ })
			.first()
			.click();
		await page.getByRole('button', { name: 'Play album', exact: true }).click();
		const now = page.getByRole('region', { name: 'Now playing' });
		await expect(now.getByText('Overtones', { exact: true }).first()).toBeVisible({
			timeout: 12000
		});
		const samples = await page.evaluate(() => window.transitionSamples);
		const overlap = samples.filter((s) => s.two);
		if (example.expected) {
			expect(6 - overlap[0].time).toBeCloseTo(example.expected, 0);
			expect(
				overlap.some(
					(s) => s.left > 0.2 && s.left < 0.9 && s.right > 0.2 && s.right < 0.9 && s.nextTime > 0
				)
			).toBe(true);
			// The playing incoming element becomes primary, so its intro never restarts.
			expect(await page.evaluate(() => window.transitionPosition())).toBeGreaterThan(
				example.expected - 0.55
			);
		} else {
			expect(overlap).toHaveLength(0);
			expect(samples.filter((s) => s.time > 5.3).some((s) => s.left === 1)).toBe(true);
		}
		expect(fixture.streams).toHaveLength(2);
	});
}

test('pausing during an overlap silences both tracks and keeps the current queue entry', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dn.mobile.track-fades.v2',
			JSON.stringify({ fadeInMs: 0, fadeOutMs: 0, smart: true })
		);
		const elements: HTMLAudioElement[] = [];
		Object.assign(window, {
			liveDecks: () => elements.filter((el) => !el.paused && el.volume > 0 && el.currentSrc).length,
			Audio: new Proxy(window.Audio, {
				construct(target, args) {
					const element = Reflect.construct(target, args) as HTMLAudioElement;
					elements.push(element);
					return element;
				}
			})
		});
	});
	await connect(page, true, undefined, false, 'listener', { head: 1.6, tail: 1.6, album: false });
	await page
		.getByRole('button', { name: /Nightfall/ })
		.first()
		.click();
	await page.getByRole('button', { name: 'Play album', exact: true }).click();
	const now = page.getByRole('region', { name: 'Now playing' });
	await expect.poll(() => page.evaluate(() => window.liveDecks()), { timeout: 9000 }).toBe(2);
	await now.getByRole('button', { name: 'Pause', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.liveDecks())).toBe(0);
	await expect(now.getByText('Reflections', { exact: true }).first()).toBeVisible();
	await expect(now.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});
