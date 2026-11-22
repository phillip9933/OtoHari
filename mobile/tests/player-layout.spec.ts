import { legacyRowDefaults } from '../src/lib/player/layout';
import { chooseOption } from './fixtures/inlineChoice';
import { verticalSwipe } from './fixtures/verticalSwipe';
import { touchRange } from './fixtures/touchRange';
import { seedOfflineMusic } from './fixtures/offlineMusic';
import { silentWav } from './fixtures/silentWav';
import { localSignIn } from './fixtures/localSignIn';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
const server = 'https://layout.example/dn';
const otherServer = 'https://layout.example/elsewhere';
const songs = ['Night Train', 'Day Train'];
async function fixture(page: Page, songTitles = songs) {
	const wav = silentWav(),
		ratings: Record<string, number> = {},
		favorites: Record<string, boolean> = {},
		lookups: string[] = [];
	const playlistPosts: string[][] = [];
	let user = 'alex';
	let savedIds: string[] = [];
	const playlist = { id: 'road', name: 'Road', can_edit: true, is_owner: true, song_count: 0 };
	await page.route('https://layout.example/**/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url()),
			path = url.pathname.split('/api/v3')[1];
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') {
			user = req.postDataJSON().username;
			return json({ token: 'fixture-' + user });
		}
		expect(req.headers().authorization).toBe('Bearer fixture-' + user);
		if (path === '/me') return json({ id: user, display_name: 'Listener', role: 'user' });
		if (path === '/home') return json({ sections: [] });
		if (path === '/me/section-prefs') return json({ pages: { home: [], discover: [] } });
		if (path === '/library/albums')
			return json({
				items: [{ id: 'record', title: 'Railway', artist_name: 'The Lines', art_missing: true }],
				next: null
			});
		const rows = songTitles.map((title, i) => ({
			id: 't' + i,
			title,
			artist_name: 'The Lines',
			album_id: 'record',
			album_title: 'Railway',
			track_number: i + 1,
			disc_number: 1,
			duration_seconds: 60,
			art_missing: true,
			favorite: !!favorites['t' + i],
			format: 'flac',
			bit_rate: 1021,
			file_size_bytes: 3145728,
			channels: 2,
			genre: 'Jazz',
			year: 1987,
			sample_rate: 44100,
			bit_depth: 16
		}));
		if (path === '/library/albums/match/record') return json({ items: rows, total: rows.length });
		if (path === '/library/tracks') {
			if (url.searchParams.has('q')) lookups.push(url.searchParams.get('q')!);
			return json({
				items: rows.filter((row) => row.title === url.searchParams.get('q')),
				next: null
			});
		}
		if (path === '/ratings/lookup') return json({ tracks: ratings, artists: {}, albums: {} });
		if (path.startsWith('/ratings/track/')) {
			expect(req.method()).toBe('PUT');
			const id = path.split('/').at(-1)!;
			ratings[id] = req.postDataJSON().rating;
			return json({ item_id: id, kind: 'track', rating: ratings[id] });
		}
		if (path.startsWith('/favorites/track/')) {
			const id = path.split('/').at(-1)!;
			favorites[id] = req.postDataJSON().favorited;
			return json({ favorited: favorites[id] });
		}
		if (path.endsWith('/lyrics'))
			return json({
				is_synced: true,
				lines: [
					{ start_seconds: 0, text: 'First line' },
					{ start_seconds: 32, text: 'At the station' }
				]
			});
		if (path === '/playlists') return json({ playlists: [playlist] });
		if (path === '/playlists/road' && req.method() === 'GET')
			return json({
				...playlist,
				tracks: savedIds.map((id) => ({ source: 'local', source_id: id }))
			});
		if (path === '/playlists/road/tracks') {
			const body = req.postDataJSON();
			savedIds = body.tracks.map((t: { track_source_id: string }) => t.track_source_id);
			playlistPosts.push(savedIds);
			return json({ tracks: body.tracks });
		}
		if (path.startsWith('/stream/local/'))
			return route.fulfill({ body: wav, contentType: 'audio/wav' });
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected ' + req.method() + ' ' + path);
	});
	return { ratings, favorites, lookups, playlistPosts };
}
async function play(page: Page, user = 'alex', address = server) {
	await page.goto('/');
	await page.getByLabel('Server address').fill(address);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill(user);
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page
		.getByRole('button', { name: /Railway/ })
		.first()
		.click();
	await page.getByRole('button', { name: 'Play album' }).click();
	await expect(page.getByRole('heading', { name: 'Night Train' })).toBeVisible();
	await page
		.locator('[data-part=now-playing]')
		.getByRole('button', { name: 'Pause', exact: true })
		.click();
}

test('Japanese navigation keeps library titles that match interface labels in their original language', async ({
	page
}) => {
	await fixture(page, ['Home', 'Settings']);
	await localSignIn(page, server);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'App language', exact: true }).click();
	await chooseOption(page.getByRole('combobox', { name: 'App language' }), 'ja');
	await page.getByRole('button', { name: '戻る', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'ナビゲーションのショートカット' })
		.getByRole('button', { name: 'ホーム', exact: true })
		.click();
	await page
		.getByRole('button', { name: /Railway/ })
		.first()
		.click();
	await expect(page.getByRole('heading', { name: 'Railway' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'アルバムを再生' })).toBeVisible();
	for (const title of ['Home', 'Settings'])
		await expect(page.getByText(title, { exact: true })).toBeVisible();
});

test('signal path shows the library source separately from the observed stream, and suggestions join Up Next', async ({
	page
}) => {
	await fixture(page);
	let plans = 0;
	await page.route(server + '/api/v3/discover/radio/plan', async (route) => {
		plans++;
		await route.fulfill({
			json: {
				tracks: [
					{
						in_library: true,
						local_file_id: 'extra',
						track_name: 'New music',
						artist_name: 'Another artist'
					}
				]
			}
		});
	});
	await play(page);
	await page.getByRole('button', { name: 'More actions', exact: true }).click();
	await page.getByRole('button', { name: 'Signal path', exact: true }).click();
	const signal = page.getByRole('dialog', { name: 'Signal path' });
	await expect(
		signal.locator('section').filter({ has: page.getByRole('heading', { name: 'Source file' }) })
	).toContainText('FLAC · 44.1 kHz · 16-bit · 1021 kbps');
	await expect(
		signal.locator('section').filter({ has: page.getByRole('heading', { name: 'Playing stream' }) })
	).toContainText('PCM');
	await expect(signal.getByText('Network stream', { exact: true })).toBeVisible();
	await expect(signal.getByText('Original file', { exact: true })).toBeVisible();
	await expect(
		signal.locator('section').filter({ has: page.getByRole('heading', { name: 'Output device' }) })
	).toContainText('Not reported');
	await signal.getByRole('button', { name: 'Close Signal path' }).click();
	await page.getByRole('button', { name: 'Show play queue' }).click();
	expect(plans).toBe(0);
	await page.getByRole('button', { name: 'Similar tracks' }).click();
	const preview = page.getByRole('dialog', { name: 'Similar tracks' });
	await preview.getByRole('button', { name: 'Add to Up Next · New music' }).click();
	await expect(preview.getByRole('status')).toContainText('New music');
	await preview.getByRole('button', { name: 'Close Similar tracks' }).click();
	const queue = page.locator('[data-part="play-queue"]');
	await expect(queue.locator('strong')).toHaveText(['Night Train', 'New music', 'Day Train']);
	await expect(queue.getByRole('heading')).toHaveText(['Up Next', 'Continue original queue']);
	await expect(queue.locator('[aria-current="true"]')).toContainText('Night Train');
	const grouped = queue.getByRole('listitem').filter({ has: page.getByRole('heading') });
	for (const editMode of [false, true]) {
		if (editMode) await page.getByRole('button', { name: 'Edit queue' }).click();
		for (const row of await grouped.all()) {
			const track = row.getByRole('button').filter({ has: page.locator('strong') });
			const box = (await track.boundingBox())!;
			const heading = (await row.getByRole('heading').boundingBox())!;
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
			await track.click({ trial: true });
			if (editMode) {
				const grip = row.getByRole('button', { name: /^Reorder / });
				const handle = (await grip.boundingBox())!;
				expect(handle.y + handle.height / 2).toBeLessThan(box.y + box.height);
				expect(handle.x).toBeGreaterThanOrEqual(box.x + box.width - 1);
				await grip.click({ trial: true });
			}
		}
	}
	expect(plans).toBe(1);
});

const editorButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function customize(page: Page, name: string) {
	await editorButton(page, 'Select ' + name).click();
	await editorButton(page, 'Edit item').click();
	await expect(page.getByRole('dialog')).toBeVisible();
}

async function addFeature(page: Page, name: string) {
	await editorButton(page, 'Add item').click();
	await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
	await expect(page.getByRole('button', { name: 'Select ' + name, exact: true })).toBeAttached();
	if (await editorButton(page, 'Done').isVisible()) await editorButton(page, 'Done').click();
}

async function removeField(page: Page, name: string) {
	await customize(page, name);
	await editorButton(page, 'Remove item').click();
}

async function closeThroughMore(page: Page) {
	await editorButton(page, 'More actions').click();
	await page.getByRole('dialog').getByRole('button', { name: 'Close player', exact: true }).click();
}

async function openEditor(page: Page) {
	const shortcut = page
		.locator('[data-part=now-playing]')
		.getByRole('button', { name: 'Player settings', exact: true });
	if (await shortcut.isVisible()) await shortcut.click();
	else if (await editorButton(page, 'More actions').isVisible()) {
		await editorButton(page, 'More actions').click();
		await editorButton(page, 'Edit player layout').click();
	} else {
		const grid = page.locator('[data-part=now-playing]');
		const area = (await grid.boundingBox())!;
		await verticalSwipe(
			page,
			area.x + area.width / 2,
			area.y + area.height * 0.18,
			area.height * 0.45
		);
		await page
			.getByRole('navigation', { name: 'Music' })
			.getByRole('button', { name: 'Home', exact: true })
			.click();
		await editorButton(page, 'Settings').click();
		await editorButton(page, 'Now Playing layout').click();
	}
	await expect(page.locator('[data-part=layout-editor] [data-player-grid]')).toBeVisible();
}

for (const [surface, palette] of [
	['solid', 'light'],
	['glass', 'dark'],
	['blur', 'midnight']
] as const) {
	test(
		'player icons and the floating dock respect the ' + surface + ' surface',
		async ({ page }) => {
			await page.addInitScript(
				({ surface, palette }) => {
					localStorage.setItem(
						'dn.mobile.interface.v2',
						JSON.stringify({ surface, bar: 'floating' })
					);
					localStorage.setItem('dn.mobile.appearance.mode.v2', palette);
				},
				{ surface, palette }
			);
			await fixture(page, [...songs, 'Late Train', 'Early Train']);
			await play(page);
			const live = page.locator('[data-part="now-playing"]');
			const checkIcons = async (player: Locator) => {
				const painted = await player
					.locator(
						'.content button:has(.face), .fallback > button, .queue-tools > button:not(.text-button)'
					)
					.evaluateAll((buttons) =>
						buttons
							.filter((button) => {
								const style = getComputedStyle(button);
								return (
									style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
									style.backgroundImage !== 'none' ||
									style.boxShadow !== 'none' ||
									style.backdropFilter !== 'none' ||
									style.borderTopWidth !== '0px'
								);
							})
							.map((button) => button.getAttribute('aria-label'))
					);
				expect(painted).toEqual([]);
			};
			const lyrics = live.getByRole('button', { name: 'Lyrics', exact: true });
			await expect(lyrics).toBeVisible();
			await checkIcons(live);
			for (const name of ['Lyrics', 'Show play queue', 'More actions']) {
				const target = (await live.getByRole('button', { name, exact: true }).boundingBox())!;
				expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(44);
			}
			const idleColor = await lyrics.evaluate((el) => getComputedStyle(el).color);
			await lyrics.click();
			await expect(lyrics).toHaveAttribute('aria-pressed', 'true');
			await expect(lyrics).not.toHaveCSS('color', idleColor);
			await checkIcons(live);
			await page.setViewportSize({ width: 320, height: 720 });
			await live.getByRole('button', { name: 'Show play queue' }).click();
			const toolbar = live.locator('.queue-tools');
			await expect(toolbar.getByRole('button', { name: 'Edit queue' })).toBeVisible();
			await checkIcons(live);
			for (const name of ['Sleep timer', 'Shuffle upcoming']) {
				const button = toolbar.getByRole('button', { name, exact: true });
				const label = button.locator('.caption');
				await expect(label).toHaveText(name);
				const target = (await button.boundingBox())!;
				const icon = (await button.locator('svg').boundingBox())!;
				const caption = (await label.boundingBox())!;
				expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(44);
				expect(Math.abs(icon.x + icon.width / 2 - caption.x - caption.width / 2)).toBeLessThan(1);
				expect(caption.y).toBeGreaterThanOrEqual(icon.y + icon.height);
				expect(caption.height).toBeLessThanOrEqual(
					await label.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) + 1)
				);
			}
			const shuffle = toolbar.getByRole('button', { name: 'Shuffle upcoming' });
			await shuffle.click();
			await expect(toolbar.getByRole('button', { name: 'Restore original order' })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			await toolbar.getByRole('button', { name: 'Sleep timer' }).click();
			await expect(page.getByRole('dialog', { name: 'Sleep timer' })).toBeVisible();
			await page.keyboard.press('Escape');
			await live.getByRole('button', { name: 'Hide play queue' }).click();
			await expect(lyrics).toBeVisible();
			await page.setViewportSize({ width: 390, height: 844 });
			await closeThroughMore(page);
			const dock = page.getByRole('navigation', { name: 'Music' });
			await expect(dock).toHaveCSS('border-top-width', '0px');
			await expect(dock).not.toHaveCSS('box-shadow', /inset/);
			await expect(page.locator('[data-part="mini-player"]')).not.toHaveCSS('box-shadow', /inset/);
			await expect(dock).toHaveCSS('background-image', surface === 'solid' ? 'none' : /gradient/);
			await expect(dock).toHaveCSS('backdrop-filter', surface === 'blur' ? 'blur(14px)' : 'none');
			await page.getByRole('button', { name: 'Open player for Night Train' }).click();
			await openEditor(page);
			const sample = page.locator('[data-part="sample-player"]');
			await expect(sample.locator('button[aria-label="Cast and audio output"]')).toBeVisible();
			await checkIcons(sample);
			const background = await page
				.locator('html')
				.evaluate((el) => getComputedStyle(el).backgroundColor);
			const radius = await page
				.locator('html')
				.evaluate((el) => getComputedStyle(el).getPropertyValue('--radius').trim());
			const checkArt = async (player: Locator) => {
				const art = player.locator('[data-section-id="player-artwork"] .hero');
				await expect(art).toHaveCSS('border-top-left-radius', radius);
				await expect(art).toHaveCSS('border-top-right-radius', radius);
				await expect(art).toHaveCSS('overflow-x', 'clip');
				expect(
					await art.evaluate((el) => getComputedStyle(el, '::after').backgroundImage)
				).toContain(background);
			};
			await expect(page.locator('[data-part="layout-editor"]')).toHaveCSS(
				'background-color',
				background
			);
			await checkArt(sample);
			await customize(page, 'Artwork');
			const inspector = page.getByRole('dialog');
			await expect(inspector.locator('.sheet-head')).toHaveCSS(
				'background-color',
				'rgba(0, 0, 0, 0)'
			);
			await editorButton(page, 'Done').click();
			await editorButton(page, 'Preview current draft').click();
			const preview = page.getByRole('dialog', { name: 'Player layout preview' });
			await expect(preview).toHaveCSS('background-color', background);
			await expect(preview).toHaveCSS('background-image', 'none');
			await checkArt(preview);
			await editorButton(page, 'Back to editing').click();
			await editorButton(page, 'Save layout').click();
			const artwork = live.locator('[data-section-id="player-artwork"]');
			if (await artwork.locator('.lyric-art').count())
				await live.getByRole('button', { name: 'Lyrics', exact: true }).click();
			await expect(artwork.locator('[data-part="cover"]')).toHaveCSS(
				'border-top-left-radius',
				radius
			);
			await checkArt(live);
		}
	);
}

test('the queue editor restores the album order and saves similar music for the listener', async ({
	page
}) => {
	await fixture(page, [...songs, 'Late Train', 'Early Train']);
	await play(page);
	await page.getByRole('button', { name: 'Show play queue' }).click();
	const queue = page.locator('[data-part=play-queue]');
	await page.getByRole('button', { name: 'Shuffle upcoming', exact: true }).last().click();
	const restore = page.getByRole('button', { name: 'Restore original order', exact: true }).last();
	await expect(restore).toHaveAttribute('aria-pressed', 'true');
	await restore.click();
	const rows = queue.getByRole('button');
	await expect(rows.nth(0)).toContainText('Night Train');
	await expect(rows.nth(1)).toContainText('Day Train');
	await expect(rows.nth(2)).toContainText('Late Train');
	await page.getByRole('button', { name: 'Edit queue', exact: true }).click();
	const autoplay = page.getByRole('checkbox', { name: 'Autoplay when the queue ends' });
	await expect(autoplay).not.toBeChecked();
	await autoplay.check();
	await expect(autoplay).toBeChecked();
	await page.getByRole('button', { name: 'Close player', exact: true }).click();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(autoplay).toBeChecked();
	await autoplay.uncheck();
	await page.getByRole('searchbox', { name: 'Search settings' }).fill('自動再生');
	await page.getByRole('button', { name: 'Autoplay when the queue ends', exact: true }).click();
	await expect(autoplay).toBeEnabled();
	await expect(autoplay).not.toBeChecked();
});
test('timed lyrics follow playback inside their panel and let listeners read ahead until they resume', async ({
	page
}) => {
	await page.setViewportSize({ width: 360, height: 720 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await fixture(page);
	await page.route('**/api/v3/library/tracks/*/lyrics', (route) =>
		route.fulfill({
			json: {
				is_synced: true,
				lines: Array.from({ length: 60 }, (_, i) => ({
					start_seconds: i,
					text: 'Line ' + i
				}))
			}
		})
	);
	await play(page);
	const lyrics = page.locator('[data-part=lyrics]');
	await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
	const lines = lyrics.getByRole('region', { name: 'Timed lyrics' });
	await expect(lines).toBeVisible();
	const seek = page.getByRole('slider', { name: 'Playback position' });
	await seek.fill('28');
	const centerError = () =>
		lines.evaluate((box) => {
			const line = box.querySelector('[aria-current=true]')!;
			const row = line.getBoundingClientRect(),
				panel = box.getBoundingClientRect();
			return Math.abs(row.top + row.height / 2 - panel.top - panel.height / 2);
		});
	await expect(lines.locator('[aria-current=true]')).toHaveText('Line 28');
	await expect.poll(centerError).toBeLessThan(3);
	await lines.hover();
	await page.mouse.wheel(0, 160);
	const resume = lyrics.getByRole('button', { name: 'Follow current line' });
	await expect(resume).toBeVisible();
	await seek.fill('43');
	await expect(lines.locator('[aria-current=true]')).toHaveText('Line 43');
	await expect.poll(centerError).toBeGreaterThan(80);
	await resume.click();
	await expect(resume).toBeHidden();
	await expect.poll(centerError).toBeLessThan(3);
	const next = lines.getByRole('button', {
		name: 'Seek to lyric Line 45',
		exact: true
	});
	await next.click();
	await expect(lines.locator('[aria-current=true]')).toHaveText('Line 45');
	await expect.poll(centerError).toBeLessThan(3);
});

test('a listener saves, cancels and restores the Now Playing grid independently for each account and server', async ({
	page
}) => {
	await fixture(page);
	await play(page);
	const player = page.locator('[data-part=now-playing]');
	const art = player.locator('[data-section-id=player-artwork]');
	const button = (name: string) => editorButton(page, name);
	await openEditor(page);
	await removeField(page, 'Artwork');
	await removeField(page, 'Artist');
	await customize(page, 'Track title');
	await page.getByLabel('Section title').fill('On the turntable');
	await button('Done').click();
	await addFeature(page, 'Up next');
	await button('Save layout').click();
	await expect(player.locator('[data-section-id=player-up-next]')).toBeVisible();
	await expect(player.getByRole('heading', { name: 'On the turntable' })).toBeVisible();
	await expect(player.getByText('Railway', { exact: true })).toHaveCount(0);
	await expect(art).toHaveCount(0);
	await openEditor(page);
	await button('Restore default layout').click();
	await button('Cancel').click();
	await expect(player).toBeVisible();
	await expect(art).toHaveCount(0);
	await play(page, 'sam');
	await expect(art).toBeVisible();
	await play(page, 'alex', otherServer);
	await expect(art).toBeVisible();
	await play(page, 'alex');
	await expect(player.getByRole('heading', { name: 'On the turntable' })).toBeVisible();
	await openEditor(page);
	await button('Restore default layout').click();
	await button('Save layout').click();
	await expect(art).toBeVisible();
	await expect(player.getByRole('heading', { name: 'On the turntable' })).toHaveCount(0);
});

test('clearing the grid keeps playback and queue reachable and the listener can restore the layout', async ({
	page
}) => {
	await fixture(page);
	await play(page);
	await openEditor(page);
	const tiles = page.locator('[data-part=layout-editor] [data-grid-handle=move]');
	await expect(tiles.first()).toBeVisible();
	while (await tiles.count()) {
		await tiles.last().click();
		await editorButton(page, 'Edit item').click();
		await editorButton(page, 'Remove item').click();
	}
	await editorButton(page, 'Save layout').click();
	const player = page.locator('[data-part=now-playing]');
	await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	await player.getByRole('button', { name: 'Show play queue' }).click();
	await expect(player.getByRole('heading', { name: 'Play queue' })).toBeVisible();
	await player.getByRole('button', { name: 'Hide play queue' }).click();
	await openEditor(page);
	await editorButton(page, 'Restore default layout').click();
	await editorButton(page, 'Save layout').click();
	await expect(player.locator('[data-section-id=player-artwork]')).toBeVisible();
});

test('current track tools rate, favorite and inspect DN audio and save songs while synced lyrics seek within the track', async ({
	page
}) => {
	const calls = await fixture(page);
	await play(page);
	await expect.poll(() => calls.lookups).toEqual(['Night Train']);
	await page.getByRole('button', { name: 'Track details for Night Train' }).click();
	const format = page
		.getByRole('dialog', { name: 'Track details' })
		.getByRole('region', { name: 'Format' });
	await expect(format.getByText('FLAC', { exact: true })).toBeVisible();
	await expect(format.getByText('16-bit', { exact: true })).toBeVisible();
	await expect(format.getByText('44.1 kHz', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Close Track details' }).click();
	await page.getByRole('button', { name: 'More actions', exact: true }).click();
	const actions = page.getByRole('dialog', { name: 'More actions' });
	await actions.getByRole('button', { name: 'Favorite track', exact: true }).click();
	await expect(actions.getByRole('button', { name: 'Remove track from favorites' })).toBeVisible();
	await actions.getByRole('button', { name: 'Rate 4 stars' }).click();
	await expect(actions.getByRole('button', { name: 'Rate 4 stars' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	expect(calls.ratings).toEqual({ t0: 4 });
	expect(calls.favorites).toEqual({ t0: true });
	await expect(actions.getByRole('button', { name: 'Clear rating' })).toHaveCount(0);
	await actions.getByRole('button', { name: 'Rate 4 stars' }).click();
	await expect.poll(() => calls.ratings.t0).toBe(0);
	await page.getByRole('button', { name: 'Close More actions' }).click();
	await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
	await page.getByRole('button', { name: 'Seek to lyric At the station' }).click();
	await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('32');
	expect(calls.lookups).toEqual(['Night Train', 'Night Train', 'Night Train']);
	await page.getByRole('button', { name: 'More actions', exact: true }).click();
	await page.getByRole('button', { name: 'Add to playlist', exact: true }).click();
	let dialog = page.getByRole('dialog').last();
	await dialog.getByRole('button', { name: 'Add track', exact: true }).click();
	await expect(dialog.getByText('Added 1 track to Road.')).toBeVisible();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await page.getByRole('button', { name: 'Close More actions' }).click();
	await page.getByRole('button', { name: 'Show play queue' }).click();
	await page.getByRole('button', { name: 'Edit queue' }).click();
	await page.getByRole('button', { name: 'Save queue to playlist' }).click();
	dialog = page.getByRole('dialog');
	await dialog.getByRole('button', { name: 'Add 2 tracks' }).click();
	await expect(dialog.getByText('Added 2 tracks to Road.')).toBeVisible();
	expect(calls.playlistPosts).toEqual([['t0'], ['t0', 't1']]);
	await dialog.getByRole('button', { name: 'Done' }).click();
	await page.getByRole('button', { name: 'Clear upcoming' }).click();
	await expect(page.locator('[data-part=play-queue] li')).toHaveCount(1);
	await expect(page.locator('[data-part=play-queue] [aria-current=true]')).toContainText(
		'Night Train'
	);
	await page.getByRole('button', { name: 'Hide play queue' }).click();
	await expect(page.getByRole('slider', { name: 'Playback position' })).toHaveValue('32');
	await expect(
		page
			.locator('[data-section-id=player-toggle]')
			.getByRole('button', { name: 'Play', exact: true })
	).toBeVisible();
});

test('a listener sizes independent metadata tiles and saves a live text template', async ({
	page
}) => {
	await fixture(page);
	await play(page);
	const player = page.locator('[data-part=now-playing]');
	const button = (name: string) => editorButton(page, name);
	await openEditor(page);
	// Free adjacent cells so the title and artist can be laid out on one line.
	await removeField(page, 'Artwork');
	await customize(page, 'Track title');
	await page.getByText('Position and size', { exact: true }).click();
	await page.getByLabel('Column', { exact: true }).fill('1');
	await page.getByLabel('Width in cells').fill('18');
	await page.getByLabel('Row', { exact: true }).fill('3');
	await button('Done').click();
	await customize(page, 'Artist');
	await page.getByText('Position and size', { exact: true }).click();
	await page.getByLabel('Width in cells').fill('10');
	await page.getByLabel('Row', { exact: true }).fill('1');
	await page.getByLabel('Column', { exact: true }).fill('19');
	await page.getByLabel('Row', { exact: true }).fill('3');
	await button('Done').click();
	await customize(page, 'Track title');
	await chooseOption(page.getByRole('combobox', { name: 'Horizontal alignment' }), 'end');
	await chooseOption(page.getByRole('combobox', { name: 'Text size' }), 'large');
	await button('Done').click();
	await addFeature(page, 'Custom text');
	await customize(page, 'Custom text');
	await page.getByLabel('Text template').fill('{position}/{count} · {title} — {duration}');
	await button('Done').click();
	await button('Save layout').click();
	const artist = player.locator('[data-section-id=player-artist]'),
		title = player.locator('[data-section-id=player-title]');
	await expect(artist).toHaveText('The Lines');
	await expect(title).toHaveText('Night Train');
	const a = (await artist.boundingBox())!,
		t = (await title.boundingBox())!;
	expect(a.x).toBeGreaterThan(t.x);
	expect(Math.abs(a.y - t.y)).toBeLessThan(1);
	expect(t.width).toBeGreaterThan(a.width * 1.6);
	await expect(player.getByText('1/2 · Night Train — 1:00', { exact: true })).toBeVisible();
	await player.getByRole('button', { name: 'Next track', exact: true }).click();
	await expect(player.getByText('2/2 · Day Train — 1:00', { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 320, height: 694 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
	await openEditor(page);
	await removeField(page, 'Artist');
	await button('Cancel').click();
	await expect(artist).toHaveText('The Lines');
});

test('older vertical layouts retain their settings and individual transport buttons remain usable in a narrow row', async ({
	page
}) => {
	await fixture(page);
	const legacy = [
		{ id: 'player-track', title: 'Record sleeve', preview: false },
		{ id: 'player-transport', title: '', preview: true },
		{ id: 'player-timeline', title: '', preview: true }
	];
	await page.addInitScript(
		({ server, legacy }) => {
			const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
			if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(legacy));
		},
		{ server, legacy }
	);
	await play(page);
	const player = page.getByRole('region', { name: 'Now playing' });
	await expect(player.locator('[data-part=player-row]')).toHaveCount(3);
	await expect(player.getByRole('heading', { name: 'Record sleeve' })).toBeVisible();
	await expect(player.locator('[data-section-id=player-track]')).not.toContainText('Railway');
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	await button('Player settings').click();
	await customize(page, 'Playback controls');
	await button('Split into individual controls').click();
	await button('Save layout').click();
	await expect(player).toBeVisible();
	await page.setViewportSize({ width: 320, height: 694 });
	const controls = player.locator('[data-player-grid]');
	const playButton = controls.getByRole('button', { name: 'Play', exact: true });
	const previous = controls.getByRole('button', { name: 'Previous track' }),
		next = controls.getByRole('button', { name: 'Next track' });
	for (const control of [previous, playButton, next]) {
		const rect = await control.boundingBox();
		expect(rect!.width).toBeGreaterThanOrEqual(44);
		expect(rect!.height).toBeGreaterThanOrEqual(44);
	}
	await playButton.click();
	await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
	await next.click();
	await expect(player.getByRole('heading', { name: 'Day Train' })).toBeVisible();
});

test('independent queue, favorite and playlist fields control the current DN track with the header close action hidden', async ({
	page
}) => {
	const calls = await fixture(page);
	await play(page);
	const region = page.locator('[data-part=now-playing]'),
		button = (name: string) => page.getByRole('button', { name, exact: true });
	await openEditor(page);
	await removeField(page, 'Artwork');
	await addFeature(page, 'Audio quality');
	await customize(page, 'Track rating');
	await page.getByText('Position and size', { exact: true }).click();
	await page.getByLabel('Column', { exact: true }).fill('1');
	await page.getByLabel('Width in cells').fill('30');
	await button('Done').click();
	for (const name of ['Add to playlist', 'Offline download', 'Seek bar', 'Duration'])
		await addFeature(page, name);
	await button('Save layout').click();
	const quality = region.locator('[data-section-id=player-quality] [data-part=audio-quality]');
	await expect(quality).toContainText('PCM', { useInnerText: true });
	await expect(quality).toHaveAttribute('title', 'Lossless · PCM · 16-bit · 8 kHz · 128 kbps');
	const download = region.locator('[data-section-id=player-download]');
	await download.getByRole('button', { name: 'Save offline', exact: true }).click();
	await expect(download.getByRole('button', { name: 'Manage track download' })).toHaveText(
		'Downloaded'
	);
	await region
		.locator('[data-section-id=player-rating]')
		.getByRole('button', { name: 'Rate 3 stars' })
		.click();
	await expect.poll(() => calls.ratings.t0).toBe(3);
	await expect(region.locator('[data-section-id=player-seek]').getByRole('slider')).toBeVisible();
	await expect(region.locator('[data-section-id=player-duration]')).toHaveText('1:00');
	const fav = region.locator('[data-section-id=player-favorite]');
	await fav.getByRole('button', { name: 'Favorite track' }).click();
	await expect(fav.getByRole('button', { name: 'Remove track from favorites' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	expect(calls.favorites.t0).toBe(true);
	await region
		.locator('[data-section-id=player-playlist]')
		.getByRole('button', { name: 'Add to playlist' })
		.click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('button', { name: 'Add track', exact: true }).click();
	await expect(dialog.getByText('Added 1 track to Road.')).toBeVisible();
	await dialog.getByRole('button', { name: 'Done' }).click();
	await region
		.locator('[data-section-id=player-queue]')
		.getByRole('button', { name: 'Show play queue' })
		.click();
	await expect(region.getByRole('heading', { name: 'Play queue' })).toBeVisible();
	await region.getByRole('button', { name: 'Hide play queue' }).click();
	await expect(region.getByRole('button', { name: 'Player menu' })).toHaveCount(0);
	await expect(page.locator('.shell.pulling')).toHaveCount(0);
	const area = (await region.boundingBox())!;
	await verticalSwipe(page, area.x + area.width / 2, area.y + area.height * 0.2, area.height * 0.5);
	await expect(page.locator('[data-part=mini-player]')).toBeVisible();
});

test('Android Back discards a sample layout and returns to the empty player from either entry point', async ({
	page
}) => {
	await fixture(page);
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('alex');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Now Playing layout' }).click();
	const player = page.getByRole('region', { name: 'Now playing', exact: true });
	await removeField(page, 'Artwork');
	await page.keyboard.press('Escape');
	await expect(player.getByRole('heading', { name: 'Nothing playing' })).toBeVisible();
	await player.getByRole('button', { name: 'Player settings' }).click();
	await expect(page.getByRole('button', { name: 'Select Artwork', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(player.getByRole('heading', { name: 'Nothing playing' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

test('a playback tile can fill its container or use a fixed icon and keep a custom label during playback', async ({
	page
}) => {
	await fixture(page);
	await play(page);
	const button = (name: string) => editorButton(page, name);
	await openEditor(page);
	await customize(page, 'Play or pause');
	await chooseOption(page.getByLabel('Icon sizing'), 'fixed');
	await page.getByLabel('Icon size').fill('16');
	await button('Done').click();
	const tile = page.locator('[data-part=sample-player] [data-section-id=player-toggle]');
	const original = (await tile.locator('.glyph').boundingBox())!.height;
	await customize(page, 'Play or pause');
	await chooseOption(page.getByLabel('Icon sizing'), 'fill');
	await chooseOption(page.getByLabel('Label', { exact: true }), 'show');
	await page.getByLabel('Label name').fill('Listen');
	await chooseOption(page.getByLabel('Label position'), 'above');
	await button('Done').click();
	await button('Preview current draft').click();
	const preview = page.locator('[data-part=draft-player] [data-section-id=player-toggle]');
	await expect(preview.locator('.caption')).toHaveText('Listen');
	expect((await preview.locator('.glyph').boundingBox())!.height).toBeGreaterThan(original + 1);
	await button('Back to editing').click();
	await button('Save layout').click();
	const live = page.locator('[data-part=now-playing] [data-section-id=player-toggle]');
	await expect(live.locator('.caption')).toHaveText('Listen');
	await expect(live.locator('.face')).toHaveAttribute('data-label-position', 'above');
	await expect(live.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	const box = (await live.locator('.glyph').boundingBox())!;
	expect(Math.abs(box.height - box.width)).toBeLessThan(1);
	expect(box.height).toBeGreaterThan(original + 1);
});

test('an older header keeps its control sizes and accessible inspector focus when saved as a grid', async ({
	page
}) => {
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
	await page.addInitScript(
		({ key }) => {
			if (localStorage.getItem(key)) return;
			const fields = [
				{ id: 'player-track' },
				{ id: 'player-transport' },
				{ id: 'player-close', placement: 'header-end', icon: 'circle-play', iconSize: 32 },
				{ id: 'player-queue', placement: 'header-start', icon: 'square-play', iconSize: 36 },
				{ id: 'player-output', placement: 'hidden' }
			];
			localStorage.setItem(
				key,
				JSON.stringify(fields.map((s) => ({ title: '', preview: true, ...s })))
			);
		},
		{ key }
	);
	await page.setViewportSize({ width: 320, height: 720 });
	await fixture(page);
	await play(page);
	const live = page.locator('[data-part=now-playing]'),
		sample = page.locator('[data-part=sample-player]'),
		button = (name: string) => page.getByRole('button', { name, exact: true });
	const ids = (where: typeof live) =>
		where
			.locator('header [data-section-id]')
			.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-section-id')));
	const geometry = async (where: typeof live, id: string, size: number) => {
		const field = where.locator('[data-section-id="' + id + '"]');
		const faces = field.locator('.content .icon-button, .content .glyph > svg');
		await expect(faces).toHaveCount(2);
		const boxes = await faces.evaluateAll((nodes) =>
			nodes.map((n) => {
				const box = n.getBoundingClientRect();
				const scale = parseFloat(getComputedStyle(n).getPropertyValue('--draft-scale')) || 1;
				return { w: box.width / scale, h: box.height / scale };
			})
		);
		for (const box of boxes) expect(Math.abs(box.w - box.h)).toBeLessThan(1);
		expect(boxes[0].w).toBeGreaterThanOrEqual(43.99);
		expect(boxes[1].w).toBeGreaterThanOrEqual(size - 0.5);
		expect(boxes[1].w).toBeLessThanOrEqual(boxes[0].w + 0.5);
	};
	const order = ['player-queue', 'player-heading', 'player-close', 'player-settings'];
	expect(await ids(live)).toEqual(order);
	await geometry(live, 'player-close', 32);
	await geometry(live, 'player-queue', 36);
	await button('Player settings').click();
	await expect(sample.locator('[data-player-grid]')).toBeVisible();
	await geometry(sample, 'player-queue', 36);
	const field = button('Select Close player');
	await field.focus();
	await field.press('Enter');
	await expect(field).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('dialog')).toBeHidden();
	const edit = button('Edit item');
	await edit.focus();
	await edit.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Close player' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(edit).toBeFocused();
	await customize(page, 'Player heading');
	await page.getByText('Position and size', { exact: true }).click();
	await page.getByLabel('Width in cells').fill('1');
	await button('Done').click();
	await button('Add item').click();
	await expect(page.getByRole('dialog')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(button('Add item')).toBeFocused();
	await button('Save layout').click();
	for (const id of order)
		await expect(live.locator('[data-player-grid] [data-section-id="' + id + '"]')).toBeVisible();
	await geometry(live, 'player-close', 32);
	await geometry(live, 'player-queue', 36);
	await button('Show play queue').click();
	await expect(live.getByRole('heading', { name: 'Play queue' })).toBeVisible();
	await button('Hide play queue').click();
	await expect(live.locator('[data-player-grid]')).toBeVisible();
	await geometry(live, 'player-close', 32);
	const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).sections, key);
	expect(stored.find((s: { id: string }) => s.id === 'player-close')).toMatchObject({
		icon: 'circle-play',
		iconSize: 32
	});
	await expect(live.locator('[data-section-id="player-output"]')).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('animated seek tapers into the buffered rail without a thumb and still seeks to both ends', async ({
	page
}) => {
	const { defaultGridLayout } = await import('../src/lib/player/grid');
	const sections = defaultGridLayout();
	sections.find((section) => section.id === 'player-timeline')!.seekStyle = 'animated';
	await page.addInitScript(
		({ key, sections }) => localStorage.setItem(key, JSON.stringify({ version: 3, sections })),
		{ key: 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']), sections }
	);
	await fixture(page);
	await play(page);
	const live = page.locator('[data-part=now-playing]');
	const bar = live.locator('[data-part=playback-bar]');
	const slider = bar.getByRole('slider');
	const wave = bar.locator('path.wave');
	await expect(wave).toBeVisible();
	await slider.fill('30');
	const boundary = bar.locator('clipPath[id$="-upcoming"] rect');
	await expect(boundary).toHaveAttribute('x', '112');
	await expect(bar.locator('clipPath[id$="-buffered"] rect')).toHaveAttribute('width', '224');
	await expect(bar.locator('clipPath[id$="-played"] rect')).toHaveAttribute('width', '112');
	await expect(bar.locator('.thumb')).toHaveCount(0);
	await expect(wave).toHaveAttribute('transform', 'translate(112 0)');
	const unplayedClip = await boundary.locator('..').getAttribute('id');
	expect(await bar.locator('use.unplayed').locator('..').getAttribute('clip-path')).toBe(
		'url(#' + unplayedClip + ')'
	);
	await live.getByRole('button', { name: 'Play', exact: true }).click();
	const animation = wave.locator('animate');
	await expect(animation).toHaveCount(1);
	const phases = await wave.evaluate((element) => {
		const path = element as SVGPathElement;
		const svg = path.ownerSVGElement!;
		const start = svg.getCurrentTime();
		svg.pauseAnimations();
		try {
			return [0, 0.25, 0.5, 0.75].map((phase) => {
				svg.setCurrentTime(start + phase);
				const end = path.getTotalLength();
				return {
					tip: path.getPointAtLength(end).y,
					tangent: path.getPointAtLength(end - 1).y,
					taper: path.getPointAtLength(end - 6).y,
					wave: path.getPointAtLength(end - 30).y
				};
			});
		} finally {
			svg.setCurrentTime(start);
			svg.unpauseAnimations();
		}
	});
	for (const phase of phases) {
		expect(phase.tip).toBeCloseTo(12);
		expect(phase.tangent).toBeCloseTo(12);
		expect(Math.abs(phase.taper - 12)).toBeLessThan(1);
	}
	const heights = phases.map((phase) => phase.wave);
	expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(3);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(animation).toHaveCount(0);
	await live.getByRole('button', { name: 'Pause', exact: true }).click();
	await slider.focus();
	await slider.press('Home');
	await expect(slider).toHaveValue('0');
	await slider.press('ArrowRight');
	await expect(slider).toHaveValue('0.1');
	await slider.fill('30');
	const rail = (await slider.boundingBox())!;
	for (const edge of ['left', 'right']) {
		await page.mouse.move(
			rail.x + (edge === 'left' ? 1 : rail.width - 1),
			rail.y + rail.height / 2
		);
		await page.mouse.down();
		await expect(slider).toHaveValue(edge === 'left' ? '0' : '60');
		await expect(boundary).toHaveAttribute('x', edge === 'left' ? '0' : '224');
		await expect(wave).toHaveAttribute(
			'transform',
			edge === 'left' ? 'translate(0 0)' : 'translate(224 0)'
		);
		await page.mouse.up();
	}
});

test('the waveform measures the playing file and its time labels can be chosen independently', async ({
	page
}) => {
	await fixture(page);
	await page.addInitScript((address) => {
		const sections = [
			{ id: 'player-track' },
			{ id: 'player-transport' },
			{
				id: 'player-timeline',
				seekStyle: 'waveform',
				showElapsed: false,
				showRemaining: true,
				showDuration: true
			},
			{ id: 'player-quality' }
		].map((s) => ({ title: '', preview: true, ...s }));
		localStorage.setItem(
			'dn.mobile.layout.v1.' + JSON.stringify([address, 'alex', 'player']),
			JSON.stringify(sections)
		);
	}, server);
	const audio = silentWav(8);
	// Four seconds of digital silence followed by four seconds of a 400 Hz tone.
	for (let i = 32000; i < 64000; i++)
		audio.writeInt16LE(Math.round(16000 * Math.sin((i * Math.PI) / 10)), 44 + i * 2);
	let reads = 0;
	await page.route('**/api/v3/stream/local/**', (route) => {
		reads++;
		return route.fulfill({ body: audio, contentType: 'audio/wav' });
	});
	await play(page);
	const region = page.locator('[data-part=now-playing]'),
		bar = region.locator('[data-part=playback-bar]');
	await expect(bar).toHaveAttribute('data-seek-style', 'waveform');
	await expect(bar.locator('.thumb')).toBeVisible();
	await expect(bar.locator('clipPath[id$="-buffered"] rect')).toHaveAttribute('width', '224');
	const path = bar.locator('defs path');
	await expect(path).toHaveCount(1);
	const heights = Array.from((await path.getAttribute('d'))!.matchAll(/v([\d.]+)/g), (match) =>
		Number(match[1])
	);
	expect(heights).toHaveLength(112);
	expect(Math.max(...heights.slice(0, 50))).toBeLessThan(2);
	expect(Math.min(...heights.slice(60, 105))).toBeGreaterThan(18);
	expect(reads).toBe(1);
	await expect(region.locator('[data-part=audio-quality]')).toContainText('PCM · 16-bit · 8 kHz');
	await expect(bar.getByLabel('Elapsed time')).toHaveCount(0);
	await expect(bar.getByLabel('Track length')).toHaveText('0:08');
	await bar.getByRole('slider').fill('3');
	await expect(bar.getByLabel('Time remaining')).toHaveText('−0:05');
});

test('a counted sleep timer advances once per natural ending and finish-last lets the current song play out', async ({
	page
}) => {
	// This listener placed the timer directly on the player.
	await page.addInitScript(({ key, layout }) => localStorage.setItem(key, JSON.stringify(layout)), {
		key: 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']),
		layout: legacyRowDefaults()
	});
	await fixture(page);
	await play(page);
	const live = page.locator('[data-part=now-playing]');
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	await button('Sleep timer').click();
	const ruler = page.getByRole('slider', { name: 'Timer duration' });
	await ruler.focus();
	await ruler.press('ArrowRight');
	await expect(page.getByLabel('Minutes', { exact: true })).toHaveValue('16');
	await ruler.hover();
	const scale = (await ruler.boundingBox())!;
	await page.mouse.move(scale.x + scale.width / 2, scale.y + scale.height / 2);
	await page.mouse.down();
	await page.mouse.move(scale.x + scale.width / 2 - 42, scale.y + scale.height / 2, { steps: 6 });
	await page.mouse.up();
	await expect(page.getByLabel('Minutes', { exact: true })).toHaveValue('19');
	await button('Tracks').click();
	await page.getByLabel('Number of tracks', { exact: true }).fill('2');
	await button('Start timer').click();
	await button('Play').click();
	await live.getByRole('slider', { name: 'Playback position' }).fill('59.5');
	await expect(live.getByRole('heading', { name: 'Day Train' })).toBeVisible();
	await expect(button('Sleep timer')).toContainText('End of track');
	await live.getByRole('slider', { name: 'Playback position' }).fill('59.5');
	await expect(live.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	await button('Sleep timer').click();
	await expect(page.getByText('The sleep timer is off.')).toBeVisible();
	await button('Duration').click();
	await page.getByLabel('Minutes', { exact: true }).fill('1');
	await page.getByRole('switch', { name: 'Finish last track' }).check();
	await page.clock.install();
	await button('Start timer').click();
	await button('Play').click();
	await expect(live.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
	await page.clock.fastForward(60_001);
	await expect(button('Sleep timer')).toContainText('End of track');
	await expect(live.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
	await live.getByRole('slider', { name: 'Playback position' }).fill('59.5');
	await expect(live.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	await expect(live.getByRole('heading', { name: 'Day Train' })).toBeVisible();
});

test('sleep timers pause the browser queue at a wall-clock deadline and before an automatic repeat or next track', async ({
	page
}) => {
	// This listener placed the timer directly on the player.
	await page.addInitScript(({ key, layout }) => localStorage.setItem(key, JSON.stringify(layout)), {
		key: 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']),
		layout: legacyRowDefaults()
	});
	await fixture(page);
	await play(page);
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	const live = page.locator('[data-part=now-playing]');
	await button('Sleep timer').click();
	await page.getByLabel('Minutes', { exact: true }).fill('1');
	await page.clock.install();
	await button('Start timer').click();
	await live.getByRole('button', { name: 'Play', exact: true }).click();
	await button('Close player').click();
	await page.clock.fastForward(60_001);
	await expect(
		page.locator('[data-part=mini-player]').getByRole('button', { name: 'Play', exact: true })
	).toBeVisible();
	await button('Open player for Night Train').click();
	await button('Sleep timer').click();
	await expect(
		page.getByRole('status').filter({ hasText: 'The sleep timer is off.' })
	).toBeVisible();
	await button('Tracks').click();
	await button('Start timer').click();
	await expect(button('Sleep timer')).toContainText('End of track');
	await live.getByRole('button', { name: 'Play', exact: true }).click();
	await page.getByRole('slider', { name: 'Playback position' }).fill('59');
	await expect(live.getByRole('button', { name: 'Play', exact: true })).toBeVisible({
		timeout: 10000
	});
	await expect(live.getByRole('heading', { name: 'Night Train' })).toBeVisible();
	await button('Sleep timer').click();
	await button('Tracks').click();
	await button('Start timer').click();
	await button('Next track').click();
	await expect(live.getByRole('heading', { name: 'Day Train' })).toBeVisible();
	await button('Sleep timer').click();
	await expect(page.getByText('The sleep timer is off.')).toBeVisible();
	await button('Duration').click();
	await page.getByLabel('Minutes', { exact: true }).fill('5');
	await button('Start timer').click();
	await button('Sleep timer').click();
	await button('Cancel timer').click();
	await button('Repeat off. Change repeat mode').click();
	await button('Repeat all. Change repeat mode').click();
	await button('Sleep timer').click();
	await button('Tracks').click();
	await button('Start timer').click();
	await page.getByRole('slider', { name: 'Playback position' }).fill('59');
	await expect(live.getByRole('button', { name: 'Play', exact: true })).toBeVisible({
		timeout: 10000
	});
	await expect(live.getByRole('heading', { name: 'Day Train' })).toBeVisible();
	await button('Sleep timer').click();
	await expect(page.getByText('The sleep timer is off.')).toBeVisible();
});

test('a clean grid preview preserves the draft, editor scroll and keyboard focus while the real track keeps playing', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.addInitScript(() => {
		const Audio = window.Audio;
		window.Audio = new Proxy(Audio, {
			construct(target, args) {
				const el = Reflect.construct(target, args) as HTMLAudioElement;
				Object.assign(window, { fixtureAudio: el });
				return el;
			}
		});
	});
	const streams: string[] = [];
	page.on('request', (r) => {
		if (r.url().includes('/api/v3/stream/local/')) streams.push(r.url());
	});
	await fixture(page);
	await play(page);
	const b = (name: string) => page.getByRole('button', { name, exact: true });
	const live = page.locator('[data-part=now-playing]');
	await live.getByRole('slider', { name: 'Playback position' }).fill('15');
	await live.getByRole('button', { name: 'Play', exact: true }).click();
	await openEditor(page);
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
	const saved = () => page.evaluate((k) => localStorage.getItem(k), key),
		original = await saved();
	const editor = page.locator('[data-part=layout-editor]');
	const preview = b('Preview current draft');
	await customize(page, 'Track title');
	await page.getByLabel('Section title').fill('Draft sleeve');
	await b('Done').click();
	const scroll = await page.locator('main').evaluate((el) => el.scrollTop);
	await preview.tap();
	const sample = page.locator('[data-part=draft-player]');
	const back = b('Back to editing');
	await expect(back).toBeFocused();
	await expect(sample.getByRole('heading', { name: 'Draft sleeve' })).toBeVisible();
	await expect(sample.getByRole('heading', { name: 'Track Title' })).toBeVisible();
	await expect(sample.getByRole('img', { name: 'Album artwork' })).toBeVisible();
	await expect(
		sample.locator('[data-layout-drag], .editing-field, .active-field, [data-inspector], .field')
	).toHaveCount(0);
	await expect(sample.getByRole('button')).toHaveCount(0);
	const next = sample.locator('[data-section-id=player-next] button');
	const box = (await next.boundingBox())!;
	await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	await expect(back).toBeInViewport();
	await page.keyboard.press('Escape');
	await expect(preview).toBeFocused();
	await expect(editor).toBeVisible();
	expect(
		Math.abs((await page.locator('main').evaluate((el) => el.scrollTop)) - scroll)
	).toBeLessThan(2);
	await preview.tap();
	await back.tap();
	await expect(preview).toBeFocused();
	await preview.tap();
	expect(
		await page.evaluate(() =>
			window.dispatchEvent(new CustomEvent('dn-back', { cancelable: true }))
		)
	).toBe(false);
	await expect(preview).toBeFocused();
	await customize(page, 'Draft sleeve');
	await expect(page.getByLabel('Section title')).toHaveValue('Draft sleeve');
	await b('Done').click();
	expect(await saved()).toBe(original);
	await b('Cancel').click();
	await expect(live.getByRole('heading', { name: 'Night Train' })).toBeVisible();
	await expect(live.getByRole('heading', { name: 'Draft sleeve' })).toHaveCount(0);
	await expect(
		live
			.locator('[data-section-id=player-toggle]')
			.getByRole('button', { name: 'Pause', exact: true })
	).toBeVisible();
	const time = await page.evaluate(
		() => (window as unknown as { fixtureAudio: HTMLAudioElement }).fixtureAudio.currentTime
	);
	expect(time).toBeGreaterThanOrEqual(15);
	expect(streams).toEqual([server + '/api/v3/stream/local/t0']);
	expect(await saved()).toBe(original);
});

test('the clean preview keeps every player tile and Back inside the screen in both orientations', async ({
	page
}) => {
	await fixture(page);
	await play(page);
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	await openEditor(page);
	await customize(page, 'Playback position');
	await chooseOption(page.getByLabel('Seek bar style'), 'waveform');
	await button('Done').click();
	await button('Preview current draft').click();
	const dialog = page.getByRole('dialog'),
		preview = dialog.locator('[data-part=draft-player]'),
		rows = preview.locator('[data-player-grid] > [data-section-id]'),
		back = dialog.getByRole('button', { name: 'Back to editing' });
	await expect(preview.locator('[data-seek-style=waveform] svg')).toBeVisible();
	for (const size of [
		{ width: 390, height: 844 },
		{ width: 320, height: 568 },
		{ width: 667, height: 375 }
	]) {
		await page.setViewportSize(size);
		await expect(back).toBeInViewport({ ratio: 1 });
		await expect
			.poll(() =>
				rows.evaluateAll((els) => {
					if (!els.length) return false;
					const frame = els[0].closest('dialog,[role=dialog]')!;
					const button = frame.querySelector('button')!.getBoundingClientRect();
					return els.every((el) => {
						const r = el.getBoundingClientRect();
						return (
							r.width > 0 &&
							r.height > 0 &&
							r.top >= button.bottom - 1 &&
							r.bottom <= innerHeight + 1 &&
							r.left >= -1 &&
							r.right <= innerWidth + 1
						);
					});
				})
			)
			.toBe(true);
		await expect(preview.locator('[data-section-id=player-more]')).toBeInViewport({ ratio: 0.999 });
	}
	await back.click();
	await expect(button('Preview current draft')).toBeFocused();
});

test('old menu and Track tools layouts migrate to More actions without adding either retired field to the picker', async ({
	page
}) => {
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
	await page.addInitScript(
		(k) =>
			localStorage.setItem(
				k,
				JSON.stringify([
					{ id: 'player-tools', preview: false, title: '' },
					{ id: 'player-menu', preview: true, title: '', placement: 'header' }
				])
			),
		key
	);
	await fixture(page);
	await localSignIn(page, server, 'alex');
	const b = (name: string) => page.getByRole('button', { name, exact: true });
	await b('Settings').click();
	await b('Now Playing layout').click();
	await customize(page, 'More actions');
	await page.getByText('Position and size', { exact: true }).click();
	await page.getByLabel('Width in cells').fill('1');
	await b('Done').click();
	await b('Add item').click();
	const picker = page.getByRole('dialog');
	await expect(picker.getByRole('button', { name: 'Track tools', exact: true })).toHaveCount(0);
	await expect(picker.getByRole('button', { name: 'Navigation menu', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await b('Save layout').click();
	const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).sections, key);
	expect(saved.some((s: { id: string }) => s.id === 'player-more')).toBe(true);
	expect(saved.some((s: { id: string }) => s.id === 'player-menu' || s.id === 'player-tools')).toBe(
		false
	);
});
test('a migrated six-column header keeps its five controls and the empty column remains available', async ({
	page
}) => {
	const ids = [
		'player-close',
		'player-heading',
		'player-queue',
		'player-output',
		'player-settings',
		'player-slot-1'
	];
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
	await page.addInitScript(
		({ ids, key }) =>
			localStorage.setItem(
				key,
				JSON.stringify(ids.map((id) => ({ id, title: '', preview: true, placement: 'header' })))
			),
		{ ids, key }
	);
	await page.setViewportSize({ width: 320, height: 720 });
	await fixture(page);
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	const b = (name: string) => page.getByRole('button', { name, exact: true });
	await b('Continue').click();
	await page.getByLabel('Username').fill('alex');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await b('Sign in').click();
	await b('Settings').click();
	await b('Now Playing layout').click();
	const fields = (grid: boolean) =>
		page
			.locator(
				grid
					? '[data-part=sample-player] [data-player-grid] [data-section-id]'
					: '[data-part=player-header-row]:visible [data-section-id]'
			)
			.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-section-id')));
	await expect.poll(() => fields(true)).toEqual(ids.filter((id) => id !== 'player-slot-1'));
	await b('Cancel').click();
	await expect(page.getByRole('heading', { name: 'Nothing playing' })).toBeVisible();
	await expect.poll(() => fields(false)).toEqual(ids);
	await expect(b('Open navigation menu')).toHaveCount(0);
	await expect(b('Player menu')).toHaveCount(0);
	await b('Close player').click();
	await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});

test('touch users can fit the player, pull the queue down from a track and dismiss song details', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await fixture(page);
	await play(page);
	const view = page.locator('[data-part=now-playing]');
	async function allRowsFit() {
		return view.evaluate((root) => {
			const frame = root.getBoundingClientRect();
			return [...root.querySelectorAll('[data-player-grid] [data-section-id]')].every((row) => {
				const r = row.getBoundingClientRect();
				return (
					r.height > 0 &&
					r.top >= frame.top - 1 &&
					r.bottom <= Math.min(innerHeight, frame.bottom) + 1
				);
			});
		});
	}
	await expect.poll(allRowsFit).toBe(true);
	await view.screenshot({ path: test.info().outputPath('portrait-player.png') });
	await expect(view.getByRole('button', { name: 'Open navigation menu' })).toHaveCount(0);
	const title = view.locator('[data-section-id=player-title] button');
	await title.click();
	const details = page.getByRole('dialog', { name: 'Track details' });
	await expect(details.getByText('Night Train', { exact: true })).toBeVisible();
	const grip = (await details.locator('[data-sheet-grip]').boundingBox())!;
	await verticalSwipe(page, grip.x + grip.width / 2, grip.y + grip.height / 2, 70);
	await expect(details).toBeHidden();
	await expect(title).toBeFocused();
	const art = view.locator('.hero');
	await art.tap({ trial: true });
	const rect = (await art.boundingBox())!;
	expect(rect.height).toBeGreaterThan(70);
	await verticalSwipe(page, rect.x + rect.width / 2, rect.y + rect.height * 0.85, -70);
	const queue = view.locator('[data-part=play-queue]');
	await expect(queue).toBeVisible();
	const dayTrain = queue.getByRole('button', { name: /Day Train/ });
	await expect(dayTrain).toBeInViewport({ ratio: 1 });
	await dayTrain.tap({ trial: true });
	const row = (await dayTrain.boundingBox())!;
	await verticalSwipe(page, row.x + row.width / 2, row.y + row.height / 2, 76);
	await expect(queue).toBeHidden();
	await expect(view.getByRole('heading', { name: 'Night Train' })).toBeVisible();
	await page.setViewportSize({ width: 667, height: 375 });
	await expect.poll(allRowsFit).toBe(true);
	const landscape = (await art.boundingBox())!;
	await verticalSwipe(
		page,
		landscape.x + landscape.width / 2,
		landscape.y + landscape.height / 2,
		72
	);
	await expect(page.locator('[data-part=mini-player]')).toBeVisible();
});

// Measure a visible landmark even while its incoming screen is inert. A closed screen is below the viewport.
function screenTop(landmark: Locator) {
	return landmark.evaluateAll((elements) => {
		const rect = elements.map((el) => el.getBoundingClientRect()).find((r) => r.height > 0);
		return rect?.top ?? innerHeight;
	});
}

// Compare rendered pixels because inert incoming screens intentionally do not receive hit tests.
async function patchDifference(
	page: Page,
	a: Buffer,
	originA: { x: number; y: number },
	b: Buffer,
	originB: { x: number; y: number }
) {
	return page.evaluate(
		async ({ a, originA, b, originB }) => {
			async function patch(png: string, origin: { x: number; y: number }) {
				const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
				const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
				const size = 14;
				const context = new OffscreenCanvas(size, size).getContext('2d')!;
				context.drawImage(
					image,
					Math.round(origin.x),
					Math.round(origin.y),
					size,
					size,
					0,
					0,
					size,
					size
				);
				image.close();
				return context.getImageData(0, 0, size, size).data;
			}
			const [first, second] = await Promise.all([patch(a, originA), patch(b, originB)]);
			return first.reduce((sum, value, i) => sum + Math.abs(value - second[i]), 0) / first.length;
		},
		{ a: a.toString('base64'), originA, b: b.toString('base64'), originB }
	);
}

test('a listener can drag up from an empty Home screen before playing a track', async ({
	page
}) => {
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'home']);
	await page.addInitScript((key) => localStorage.setItem(key, '[]'), key);
	await fixture(page);
	await localSignIn(page, server, 'alex');
	await expect(page.getByText('Choose sections for Home in Settings.')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Current track' })).toHaveCount(0);
	const homeFrame = await page.screenshot();
	const main = (await page.getByRole('main').boundingBox())!;
	const x = main.x + main.width / 2,
		y = main.y + main.height * 0.78;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x, y - main.height / 2, { steps: 4 });
	const incoming = await screenTop(page.locator('[data-panel-layer=player]'));
	expect(incoming).toBeGreaterThan(80);
	expect(incoming).toBeLessThan(page.viewportSize()!.height - 80);
	const arrow = page.locator('[data-section-id=player-close] svg');
	async function arrowPatch() {
		const box = (await arrow.boundingBox())!;
		return { x: box.x + box.width / 2 - 7, y: box.y + box.height / 2 - 7 };
	}
	const held = await arrowPatch(),
		heldFrame = await page.screenshot({
			path: test.info().outputPath('empty-home-during-pull.png')
		});
	await page.mouse.up();
	await expect(page.getByRole('heading', { name: 'Nothing playing' })).toBeInViewport();
	await page.getByRole('button', { name: 'Close player' }).tap({ trial: true });
	const open = await arrowPatch(),
		playerFrame = await page.screenshot();
	expect(await patchDifference(page, heldFrame, held, playerFrame, open)).toBeLessThan(8);
	expect(await patchDifference(page, homeFrame, held, heldFrame, held)).toBeGreaterThan(12);
	await page.getByRole('button', { name: 'Browse music' }).click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

test('Home scrolling, dragging up to Now Playing and reversing a mini-player pull are independent', async ({
	page
}) => {
	const height = 568;
	await page.setViewportSize({ width: 390, height });
	await fixture(page);
	await play(page);
	const art = page.locator('[data-section-id=player-artwork] [data-part=cover]');
	async function coverPatch() {
		const box = (await art.boundingBox())!;
		return { x: box.x + box.width * 0.25, y: box.y + box.height * 0.2 };
	}
	await page
		.getByRole('main')
		.evaluate((el) =>
			Promise.all(el.getAnimations().map((animation) => animation.finished)).then(() => undefined)
		);
	const openPatch = await coverPatch(),
		playerFrame = await page.screenshot();
	const expandedY = await screenTop(art);
	await closeThroughMore(page);
	await page.getByRole('navigation', { name: 'Music' }).getByRole('button', { name: 'Home' }).tap();
	const home = page.getByRole('heading', { name: 'Home', exact: true });
	const main = page.getByRole('main');
	const mini = page.getByRole('region', { name: 'Current track' });
	const opener = mini.getByRole('button', { name: 'Open player for Night Train' });
	await expect(home).toBeVisible();
	const miniBox = (await mini.boundingBox())!;
	const x = 12,
		y = miniBox.y - 20;
	const touch = await touchRange(page);
	try {
		await expect
			.poll(() => main.evaluate((el) => el.scrollHeight - el.clientHeight))
			.toBeGreaterThan(50);
		await verticalSwipe(page, x, y, -75);
		await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(20);
		await expect(opener).toBeVisible();
		await main.evaluate((el) => el.scrollTo(0, el.scrollHeight));
		const catalogGeometry = () =>
			page.evaluate(() => {
				const top = (selector: string) =>
					document.querySelector(selector)!.getBoundingClientRect().top;
				return {
					head: top('.mast'),
					feed: top('[data-home-feed]'),
					mini: top('footer [data-part="mini-player"]'),
					scroll: document.querySelector('main')!.scrollTop
				};
			});
		const catalogAtRest = await catalogGeometry();
		const homeFrame = await page.screenshot();
		const brand = (await page.getByRole('img', { name: 'DroppedNeedle' }).boundingBox())!;
		const brandPatch = { x: brand.x + brand.width * 0.2, y: brand.y + brand.height * 0.3 };

		await touch.holdAt(x, y);
		await touch.moveTo(x, y - 160);
		await expect.poll(() => screenTop(art)).toBeLessThan(height - 30);
		const halfway = await screenTop(art);
		expect(halfway).toBeGreaterThan(expandedY + 70);
		expect(await catalogGeometry()).toEqual(catalogAtRest);
		const heldPatch = await coverPatch();
		const heldFrame = await page.screenshot({
			path: test.info().outputPath('home-during-pull.png')
		});
		expect(await patchDifference(page, playerFrame, openPatch, heldFrame, heldPatch)).toBeLessThan(
			6
		);
		expect(await patchDifference(page, homeFrame, heldPatch, heldFrame, heldPatch)).toBeGreaterThan(
			16
		);
		expect(await patchDifference(page, homeFrame, brandPatch, heldFrame, brandPatch)).toBeLessThan(
			2
		);
		await touch.moveTo(x, y - 45);
		await expect.poll(() => screenTop(art)).toBeGreaterThan(halfway + 55);
		expect(await catalogGeometry()).toEqual(catalogAtRest);
		await touch.moveTo(x, y - 255);
		await touch.lift();
		await expect.poll(() => screenTop(art)).toBeCloseTo(expandedY, 0);
		await expect(page.getByRole('heading', { name: 'Night Train' })).toBeVisible();

		const start = await touch.point(art);
		await touch.hold(art);
		await touch.moveTo(start.x, start.y + 155);
		await expect.poll(() => screenTop(art)).toBeGreaterThan(expandedY + 85);
		expect(await catalogGeometry()).toEqual(catalogAtRest);
		await touch.cancel();
		await expect.poll(() => screenTop(art)).toBeCloseTo(expandedY, 0);
		await touch.hold(art);
		await touch.moveTo(start.x, start.y + 255);
		await touch.lift();
		await expect(opener).toBeVisible();
		await expect.poll(catalogGeometry).toEqual(catalogAtRest);

		const startMini = await touch.point(opener);
		await page.mouse.move(startMini.x, startMini.y);
		await page.mouse.down();
		await page.mouse.move(startMini.x, startMini.y - 185, { steps: 4 });
		await expect.poll(() => screenTop(art)).toBeLessThan(height - 50);
		await page.mouse.move(startMini.x, startMini.y - 8, { steps: 4 });
		await page.mouse.up();
		await expect.poll(() => screenTop(art)).toBeGreaterThanOrEqual(height);
		await expect(opener).toBeVisible();
		await opener.tap();
		await expect(page.getByRole('heading', { name: 'Night Train' })).toBeVisible();
	} finally {
		await touch.close();
	}
});

test('pulling directly on player controls follows every held position without activating the control', async ({
	page
}) => {
	await fixture(page);
	await play(page);
	const height = page.viewportSize()!.height;
	const player = page.locator('[data-panel-layer=player]');
	const queue = page.locator('[data-panel-layer=queue]');
	const mini = page.getByRole('region', { name: 'Current track' });
	await closeThroughMore(page);
	const touch = await touchRange(page);
	try {
		const start = await touch.point(mini.getByRole('button', { name: 'Play', exact: true }));
		const miniTop = await screenTop(mini);
		await touch.holdAt(start.x, start.y);
		for (const dy of [26, 120, 74, 190]) {
			await touch.moveTo(start.x, start.y - dy);
			await expect.poll(() => screenTop(player)).toBeCloseTo(height - dy, 0);
			await expect.poll(() => screenTop(mini)).toBeCloseTo(miniTop, 0);
		}
		await touch.cancel();
		await expect(player).toHaveCount(0);
		await expect(mini.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
		await mini.getByRole('button', { name: /Open player/ }).tap();
		const playButton = player.getByRole('button', { name: 'Play', exact: true });
		await expect(playButton).toBeInViewport();
		const control = await touch.point(playButton);
		await touch.holdAt(control.x, control.y);
		for (const dy of [45, 140, 80]) {
			await touch.moveTo(control.x, control.y - dy);
			await expect.poll(() => screenTop(queue)).toBeCloseTo(height - dy, 0);
			await expect.poll(() => screenTop(player)).toBeCloseTo(-dy, 0);
			await expect
				.poll(() => screenTop(queue.locator('h1.queue-heading')))
				.toBeCloseTo(height - dy, 0);
		}
		await touch.cancel();
		await expect(queue).toHaveCount(0);
		await expect(playButton).toBeVisible();
	} finally {
		await touch.close();
	}
});

test('moving panels paint inside the system bars and keep the same player height at rest', async ({
	page
}) => {
	const top = 32,
		bottom = 28,
		height = page.viewportSize()!.height;
	const device = await page.context().newCDPSession(page);
	await device.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, bottom } });
	await fixture(page);
	await play(page);
	const player = page.locator('[data-panel-layer=player]');
	const rest = await player.boundingBox();
	expect(rest?.y).toBe(top);
	expect(rest?.height).toBe(height - top);
	// A paint marker distinguishes a correctly clipped panel from the identical theme behind it.
	await page.addStyleTag({
		content: `
		.pulling [data-panel-layer]::after {
			content: ''; position: absolute; z-index: 10; inset: 0 auto 0 0;
			width: 18px; background: magenta; pointer-events: none;
		}
	`
	});
	const before = await page.screenshot();
	const touch = await touchRange(page);
	try {
		const art = player.locator('.hero');
		const start = await touch.point(art);
		await touch.hold(art);
		await touch.moveTo(start.x, start.y - 92);
		await expect.poll(() => screenTop(player)).toBeCloseTo(top - 92, 0);
		const held = await page.screenshot();
		const sample = (y: number) => patchDifference(page, before, { x: 2, y }, held, { x: 2, y });
		expect(await sample(6)).toBeLessThan(1);
		expect(await sample(height - 22)).toBeLessThan(1);
		expect(await sample(top + 4)).toBeGreaterThan(30);
		expect(await sample(height - bottom - 20)).toBeGreaterThan(30);
		await touch.cancel();
		await expect.poll(() => player.boundingBox()).toEqual(rest);
	} finally {
		await touch.close();
		await device.detach();
	}
});

test('a mini-player queue tap slides, can be caught and held, and finishes at the original destination', async ({
	page
}) => {
	await page.addInitScript((server) => {
		localStorage.setItem('dn.mobile.interface.v2', JSON.stringify({ motion: 'gentle' }));
		localStorage.setItem(
			'dn.mobile.mini-player.v1.' + JSON.stringify([server, 'alex']),
			JSON.stringify({ after: 'queue' })
		);
	}, server);
	await fixture(page);
	await play(page);
	await closeThroughMore(page);
	const open = page.getByRole('button', { name: 'Open play queue', exact: true });
	const queue = page.locator('[data-panel-layer=queue]');
	const height = page.viewportSize()!.height;
	const touch = await touchRange(page);
	try {
		await open.tap();
		await page.waitForFunction(() => {
			const top = document.querySelector('[data-panel-layer=queue]')?.getBoundingClientRect().top;
			return top !== undefined && top < innerHeight - 4 && top > 0;
		});
		const x = 150,
			y = height - 160;
		await touch.holdAt(x, y);
		const caught = await screenTop(queue);
		expect(caught).toBeGreaterThan(1);
		expect(caught).toBeLessThan(height - 4);
		// A stationary finger owns the panel for longer than the full 280ms gentle transition.
		await page.evaluate(async () => {
			const until = performance.now() + 320;
			while (performance.now() < until) await new Promise(requestAnimationFrame);
		});
		expect(await screenTop(queue)).toBeCloseTo(caught, 0);
		await touch.moveTo(x, y + 30);
		await expect.poll(() => screenTop(queue)).toBeCloseTo(Math.min(height, caught + 30), 0);
		await touch.moveTo(x, y - height * 0.55);
		await touch.lift();
		await expect(page.getByRole('heading', { name: 'Play queue' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(open).toBeFocused();
	} finally {
		await touch.close();
	}
});

test('the play queue follows the finger both ways, preserves scrolling and never plays a dragged track', async ({
	page
}) => {
	const height = 740;
	await page.setViewportSize({ width: 390, height });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await fixture(page, [...songs, ...Array.from({ length: 35 }, (_, i) => 'Rail stop ' + i)]);
	await play(page);
	const art = page.locator('[data-section-id=player-artwork] [data-part=cover]');
	const queue = page.locator('[data-part=play-queue]');
	const heading = page.locator('[data-panel-layer=queue] h1.queue-heading');
	const open = page.getByRole('button', { name: 'Show play queue' });
	await open.tap();
	await expect(queue.getByRole('button', { name: /Day Train/ })).toBeVisible();
	const queueY = await screenTop(heading);
	await page.getByRole('button', { name: 'Hide play queue' }).tap();
	const artBox = (await art.boundingBox())!;
	const x = artBox.x + artBox.width / 2,
		y = artBox.y + artBox.height * 0.8;
	const travel = Math.min(300, y - 12);
	const touch = await touchRange(page);
	try {
		await touch.holdAt(x, y);
		await touch.moveTo(x, y - travel);
		await expect.poll(() => screenTop(heading)).toBeLessThan(height - 20);
		const halfway = await screenTop(heading);
		expect(halfway).toBeGreaterThan(queueY + 60);
		await touch.moveTo(x, y - travel + 85);
		await expect.poll(() => screenTop(heading)).toBeGreaterThan(halfway + 45);
		await touch.cancel();
		await expect(open).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Play queue' })).toBeHidden();
		await open.tap();

		const second = queue.getByRole('button', { name: /Day Train/ });
		const start = await touch.point(second);
		await touch.hold(second);
		await touch.moveTo(start.x, start.y + 165);
		await expect.poll(() => screenTop(heading)).toBeGreaterThan(queueY + 100);
		await touch.moveTo(start.x, start.y + 22);
		await expect.poll(() => screenTop(heading)).toBeLessThan(queueY + 50);
		await touch.lift();
		await expect.poll(() => screenTop(heading)).toBeCloseTo(queueY, 0);
		const queueBox = (await queue.boundingBox())!;
		await verticalSwipe(page, x, queueBox.y + queueBox.height * 0.75, -125);
		const scroll = () => queue.evaluate((el) => el.scrollTop);
		await expect.poll(scroll).toBeGreaterThan(50);
		const scrolled = await scroll();
		await verticalSwipe(page, x, queueBox.y + 90, 225);
		await expect.poll(scroll).toBeLessThan(scrolled);
		await expect(queue.getByRole('button', { name: /Night Train/ })).toHaveAttribute(
			'aria-current',
			'true'
		);
	} finally {
		await touch.close();
	}
});

test('track details reverse under the finger and finish sliding after release', async ({
	page
}) => {
	const windowHeight = page.viewportSize()!.height;
	await fixture(page);
	await play(page);
	const title = page.locator('[data-section-id=player-title] button');
	await title.tap();
	const details = page.getByRole('dialog', { name: 'Track details' });
	const heading = details.getByRole('heading', { name: 'Track details' });
	await expect(heading).toBeVisible();
	await details.evaluate((el) =>
		Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined)
	);
	const rest = await screenTop(details);
	const backdrop = () =>
		details.evaluate((el) => Number(getComputedStyle(el, '::backdrop').opacity));
	const openShade = await backdrop();
	const touch = await touchRange(page);
	try {
		const { x, y } = await touch.point(heading);
		await touch.hold(heading);
		await touch.moveTo(x, y + 145);
		await expect.poll(() => screenTop(details)).toBeGreaterThan(rest + 105);
		await expect.poll(backdrop).toBeLessThan(openShade - 0.08);
		const pulledShade = await backdrop();
		await touch.moveTo(x, y + 35);
		await expect.poll(() => screenTop(details)).toBeLessThan(rest + 55);
		await expect.poll(backdrop).toBeGreaterThan(pulledShade + 0.06);
		await touch.moveTo(x, y + 190);
		const released = await screenTop(details);
		// Sample rendered frames after the finger lifts. Removing a half-open sheet immediately looks like a jump.
		const trace = await details.evaluateHandle((sheet) => {
			const positions: number[] = [];
			const finished = new Promise<void>((done) => {
				function sample() {
					if (!sheet.isConnected || !(sheet as HTMLDialogElement).open) return done();
					positions.push(sheet.getBoundingClientRect().top);
					requestAnimationFrame(sample);
				}
				sheet.addEventListener('touchend', () => requestAnimationFrame(sample), {
					capture: true,
					once: true
				});
			});
			return { positions, finished };
		});
		await touch.lift();
		await expect(details).toBeHidden();
		const frames = await trace.evaluate(async ({ finished, positions }) => {
			await finished;
			return positions;
		});
		expect(frames.some((position) => position > released + 5 && position < windowHeight)).toBe(
			true
		);
		await trace.dispose();
		await expect(title).toBeFocused();
	} finally {
		await touch.close();
	}
});

test('a finger can catch a closing sheet, hold it still, and pull it open again', async ({
	page
}) => {
	await page.setViewportSize({ width: 360, height: 640 });
	await fixture(page);
	await play(page);
	await page.locator('[data-section-id=player-title] button').tap();
	const sheet = page.getByRole('dialog', { name: 'Track details' });
	await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
	const rest = await screenTop(sheet);
	const contents = sheet.locator('.sheet-content');
	await contents.evaluate((el) => el.scrollTo(0, 80));
	await expect.poll(() => contents.evaluate((el) => el.scrollTop)).toBeGreaterThan(20);
	// Slow only this closing transition so a busy test runner can land a real touch midway.
	await sheet.evaluate((el) => {
		el.querySelector<HTMLButtonElement>('header button')!.click();
		const slide = el
			.getAnimations()
			.find((a) => a instanceof CSSTransition && a.transitionProperty === 'transform')!;
		slide.currentTime = Number(slide.effect!.getTiming().duration) * 0.15;
		slide.updatePlaybackRate(0.12);
	});
	const touch = await touchRange(page);
	try {
		const body = (await contents.boundingBox())!;
		const x = Math.round(body.x + body.width / 2);
		const y = Math.round(body.y + 36);
		await touch.holdAt(x, y);
		const held = await screenTop(sheet);
		expect(held).toBeGreaterThan(rest + 10);
		const drift = await sheet.evaluate(async (el) => {
			const start = el.getBoundingClientRect().top;
			for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
			return Math.abs(el.getBoundingClientRect().top - start);
		});
		expect(drift).toBeLessThan(1);
		await touch.moveTo(x, Math.max(0, y - (held - rest)));
		await expect.poll(() => screenTop(sheet)).toBeCloseTo(rest, 0);
		await touch.lift();
		await expect(sheet).toBeVisible();
		await expect(sheet.getByRole('heading', { name: 'Track details' })).toBeVisible();
	} finally {
		await touch.close();
	}
});

test('the track title inspector shows the stored maximum lines when reopened', async ({ page }) => {
	await fixture(page);
	await play(page);
	await openEditor(page);
	await customize(page, 'Track title');
	const lines = page.getByRole('combobox', { name: 'Maximum lines' });
	await expect(lines).toHaveText('1');
	await chooseOption(lines, '8');
	await expect(lines).toHaveText('8');
	await editorButton(page, 'Done').click();
	await editorButton(page, 'Save layout').click();
	await openEditor(page);
	await customize(page, 'Track title');
	await expect(lines).toHaveText('8');
	await chooseOption(lines, '0');
	await expect(lines).toHaveText('Unlimited');
});

test('the editor fits its actions above the navigation inset and scrolls on short screens', async ({
	page
}) => {
	const device = await page.context().newCDPSession(page);
	try {
		await page.setViewportSize({ width: 411, height: 891 });
		await device.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 28, bottom: 48 } });
		await fixture(page);
		await play(page);
		await openEditor(page);
		const main = page.locator('main');
		const share = page.locator('[data-part="player-layout-sharing"] summary');
		const bottom = (element: typeof share) =>
			element.evaluate((el) => el.getBoundingClientRect().bottom);
		expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
		expect(await bottom(share)).toBeLessThanOrEqual(891 - 48);
		expect(await bottom(main)).toBeLessThanOrEqual(891 - 48);
		await page.setViewportSize({ width: 667, height: 375 });
		await share.scrollIntoViewIfNeeded();
		expect(await bottom(share)).toBeLessThanOrEqual(375 - 48);
		await share.tap();
		await expect(page.getByRole('group', { name: 'Layout transfer' })).toBeVisible();
	} finally {
		await device.detach();
	}
});

test('a dragged bottom sheet leaves both system bars clear', async ({ page }) => {
	const top = 32,
		bottom = 40;
	const device = await page.context().newCDPSession(page);
	const touch = await touchRange(page);
	try {
		await fixture(page);
		await play(page);
		await device.send('Emulation.setSafeAreaInsetsOverride', { insets: { top, bottom } });
		await page.addStyleTag({
			content: `
			body::before, body::after { content: ''; position: fixed; left: 0; right: 0; z-index: 10;
				pointer-events: none; background: #f8aa6b; }
			body::before { top: 0; height: env(safe-area-inset-top); }
			body::after { bottom: 0; height: env(safe-area-inset-bottom); }
			html dialog[open][data-part="player-sheet"] { background: #3689dc; }
		`
		});
		await expect
			.poll(() => page.evaluate(() => getComputedStyle(document.body, '::after').height))
			.toBe(bottom + 'px');
		const before = await page.screenshot();
		await page.locator('[data-section-id=player-title] button').tap();
		const sheet = page.getByRole('dialog', { name: 'Track details' });
		await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
		const grip = sheet.locator('[data-sheet-grip]');
		const { x, y } = await touch.point(grip);
		await touch.holdAt(x, y);
		await touch.moveTo(x, y + 120);
		const held = await page.screenshot();
		const h = page.viewportSize()!.height;
		const sample = (y: number) => patchDifference(page, before, { x: 6, y }, held, { x: 6, y });
		expect(await sample(6)).toBeLessThan(1);
		expect(await sample(h - 24)).toBeLessThan(1);
		expect(await sample(h - bottom - 18)).toBeGreaterThan(20);
		await touch.cancel();
	} finally {
		await touch.close();
		await device.detach();
	}
});

test('a saved full-screen lyrics field opens an accessible sheet and preserves the artwork', async ({
	page
}) => {
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
	await page.addInitScript(
		(key) =>
			localStorage.setItem(
				key,
				JSON.stringify([
					...'artwork title transport'
						.split(' ')
						.map((id) => ({ id: 'player-' + id, title: '', preview: true })),
					{ id: 'player-lyrics', title: '', preview: true, lyricsMode: 'sheet' }
				])
			),
		key
	);
	await fixture(page);
	await play(page);
	const trigger = page.getByRole('button', { name: 'Lyrics', exact: true });
	await trigger.click();
	const dialog = page.getByRole('dialog', { name: 'Lyrics' });
	await expect(dialog.getByRole('button', { name: 'Seek to lyric At the station' })).toBeVisible();
	expect((await dialog.boundingBox())!.height).toBeGreaterThan(
		(page.viewportSize()?.height ?? 0) * 0.9
	);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(page.locator('[data-section-id=player-artwork] [data-part=lyrics]')).toHaveCount(0);
});

test('an oversized saved composition fits all live controls after a viewport resize', async ({
	page
}) => {
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
	const ids = [
		'player-artwork',
		'player-title',
		'player-transport',
		'player-more',
		'player-timeline',
		'player-lyrics'
	];
	await page.addInitScript(
		({ key, ids }) =>
			localStorage.setItem(
				key,
				JSON.stringify(ids.map((id) => ({ id, preview: true, title: '', minHeight: 132 })))
			),
		{ key, ids }
	);
	await fixture(page);
	await play(page);
	const view = page.locator('[data-part=now-playing]');
	for (const size of [
		{ width: 320, height: 568 },
		{ width: 667, height: 375 },
		{ width: 390, height: 844 }
	]) {
		await page.setViewportSize(size);
		await expect
			.poll(() =>
				view.evaluate(
					(root, ids) =>
						ids.flatMap((id) => {
							const target = root
								.querySelector('[data-section-id="' + id + '"]')
								?.getBoundingClientRect();
							if (
								target &&
								target.height > 0 &&
								target.top >= -1 &&
								target.bottom <= innerHeight + 1
							)
								return [];
							return [{ id, top: target?.top, bottom: target?.bottom, height: innerHeight }];
						}),
					ids
				)
			)
			.toEqual([]);
	}
	// The app's error banner or an inset may reduce the available main area without a window resize.
	await page.locator('main').evaluate((main) => {
		main.style.maxHeight = '420px';
	});
	await expect
		.poll(() =>
			view.evaluate((root) => {
				const pane = root.closest('main')!.getBoundingClientRect();
				return Math.abs(root.getBoundingClientRect().height - pane.height);
			})
		)
		.toBeLessThan(1);
	await view.getByRole('button', { name: 'More actions' }).click();
	await expect(page.getByRole('dialog', { name: 'More actions' })).toBeVisible();
});

test('hiding artwork uses the full lyrics sheet and honors a listener’s More actions caption', async ({
	page
}) => {
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']);
	await page.addInitScript(
		(key) =>
			localStorage.setItem(
				key,
				JSON.stringify([
					{ id: 'player-title', title: '', preview: true },
					{ id: 'player-transport', title: '', preview: true },
					{
						id: 'player-more',
						title: '',
						preview: true,
						showLabel: true,
						labelPosition: 'above',
						labelName: 'My track actions'
					},
					{ id: 'player-lyrics', title: '', preview: true }
				])
			),
		key
	);
	await fixture(page);
	await play(page);
	const more = page.getByRole('button', { name: 'More actions', exact: true });
	await expect(more).toHaveText('My track actions');
	// More is a vertical ellipsis, independent of the listener's caption.
	const dots = await more
		.locator('svg circle')
		.evaluateAll((nodes) => nodes.map((n) => [n.getAttribute('cx'), n.getAttribute('cy')]));
	expect(dots).toHaveLength(3);
	expect(new Set(dots.map(([x]) => x)).size).toBe(1);
	expect(new Set(dots.map(([, y]) => y)).size).toBe(3);
	await expect(more.locator('[data-label-position=above]')).toBeVisible();
	await expect(page.locator('[data-section-id=player-artwork]')).toHaveCount(0);
	await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
	const lyrics = page.getByRole('dialog', { name: 'Lyrics' });
	await expect(lyrics.getByRole('button', { name: 'Seek to lyric First line' })).toBeVisible();
	const body = (await lyrics.locator('.sheet-content').boundingBox())!;
	await verticalSwipe(page, body.x + body.width / 2, body.y + 26, 85);
	await expect(lyrics).toBeHidden();
	await expect(page.getByRole('button', { name: 'Lyrics', exact: true })).toBeFocused();
});

test('track details distinguish DN source format, actual playback and each device copy without reading unrelated metadata', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 690 });
	const calls = await fixture(page);
	await play(page);
	const reads: string[] = [];
	page.on('request', (r) => {
		const url = new URL(r.url());
		if (url.pathname.includes('/api/v3/')) reads.push(url.pathname.split('/api/v3')[1]);
	});
	const title = page.getByRole('button', { name: 'Track details for Night Train' });
	const sheet = page.getByRole('dialog', { name: 'Track details' });
	await title.click();
	await expect(sheet.getByRole('heading', { name: 'Night Train' })).toBeVisible();
	await expect(sheet.locator('[data-part=cover]')).toBeVisible();
	const source = sheet.getByRole('region', { name: 'Source' }),
		format = sheet.getByRole('region', { name: 'Format' }),
		music = sheet.getByRole('region', { name: 'Music metadata' });
	await expect(source.getByText('DroppedNeedle', { exact: true })).toBeVisible();
	await expect(source.getByText('Not saved on this device')).toBeVisible();
	await expect(source.getByText('3.0 MiB')).toBeVisible();
	await expect(format.getByText('44.1 kHz', { exact: true })).toBeVisible();
	await expect(format.getByText('1021 kbps', { exact: true })).toBeVisible();
	await expect(music.getByText('Jazz', { exact: true })).toBeVisible();
	await expect(sheet.getByRole('region', { name: 'Current playback' })).toContainText(
		'PCM · 16-bit · 8 kHz · 128 kbps'
	);
	await expect(sheet.getByText('File path', { exact: true })).toHaveCount(0);
	await expect(sheet.getByText('Play count', { exact: true })).toHaveCount(0);
	expect(calls.lookups).toEqual(['Night Train', 'Night Train']);
	const copy = {
		id: 't0',
		title: 'Night Train',
		artist: 'The Lines',
		album: 'Railway',
		streamUrl: '/api/v3/stream/local/t0',
		format: 'flac',
		genre: 'Jazz'
	};
	for (const [origin, label] of [
		['cached', 'Playback cache'],
		['automatic', 'Automatically saved'],
		['downloaded', 'Saved manually']
	] as const) {
		await seedOfflineMusic(page, server, 'alex', false, [{ track: copy, origin }]);
		await expect(source.getByText(label, { exact: true })).toBeVisible();
	}
	await expect(source.getByText('Size on device', { exact: true })).toBeVisible();
	expect(
		reads.filter(
			(p) => p.startsWith('/ratings') || p.startsWith('/favorites') || p.startsWith('/playlists')
		)
	).toEqual([]);
	await sheet.getByRole('button', { name: 'Close Track details' }).click();
	await page.context().setOffline(true);
	reads.length = 0;
	await title.click();
	await expect(source.getByText('Saved manually')).toBeVisible();
	await expect(format.getByText('FLAC', { exact: true })).toBeVisible();
	await expect(format.getByText('Sample rate', { exact: true })).toHaveCount(0);
	await expect(source.getByText('File size', { exact: true })).toHaveCount(0);
	expect(reads).toEqual([]);
	await page.keyboard.press('Escape');
	await expect(title).toBeFocused();
});

test('enhanced lyrics highlight timestamped words on seek and leave untimed lines intact', async ({
	page
}) => {
	await fixture(page);
	await page.route('**/api/v3/library/tracks/*/lyrics', (route) =>
		route.fulfill({
			json: {
				is_synced: true,
				lines: [
					{ start_seconds: 0, text: '<00:00.50>First <00:01.25>word<00:02.00>' },
					{ start_seconds: 4, text: '普通の歌詞 <3' }
				]
			}
		})
	);
	await play(page);
	await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
	const lines = page.getByRole('region', { name: 'Timed lyrics' });
	const first = lines.getByRole('button', { name: 'Seek to lyric First word' });
	await expect(first).toBeVisible();
	const seek = page.getByRole('slider', { name: 'Playback position' });
	await seek.fill('1.5');
	await expect(first.locator('[data-active-word]')).toHaveText('word');
	await seek.fill('0.6');
	await expect(first.locator('[data-active-word]')).toHaveText('First ');
	await seek.fill('2.5');
	await expect(first.locator('[data-active-word]')).toHaveCount(0);
	await lines.getByRole('button', { name: 'Seek to lyric 普通の歌詞 <3' }).click();
	await expect(lines.locator('[aria-current=true]')).toHaveText('普通の歌詞 <3');
});

test('the saved player grid keeps proportional tiles, fixed and fill icons, lyrics and queue navigation', async ({
	page
}) => {
	const { defaultGridLayout } = await import('../src/lib/player/grid');
	const gridLayout = defaultGridLayout();
	const fill = gridLayout.find((s) => s.id === 'player-next')!;
	fill.iconMode = 'fill';
	fill.padding = 5;
	const feedback = await fixture(page);
	await play(page);
	await page.evaluate(
		({ server, layout }) => {
			localStorage.setItem(
				'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']),
				JSON.stringify({ version: 3, sections: layout })
			);
			window.dispatchEvent(
				new CustomEvent('dn-layout-change', { detail: { board: 'player', user: 'alex', server } })
			);
		},
		{ server, layout: gridLayout }
	);
	const live = page.locator('[data-part=now-playing]');
	const grid = live.locator('[data-player-grid]');
	await expect(grid).toBeVisible();
	await expect(live.locator('[data-part=player-header-row]')).toHaveCount(0);
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 320, height: 568 },
		{ width: 844, height: 390 }
	]) {
		await page.setViewportSize(viewport);
		const timeline = grid.locator('[data-section-id=player-timeline]');
		await expect
			.poll(() =>
				timeline.evaluate((tile) => {
					const bounds = tile.getBoundingClientRect();
					return [...tile.querySelectorAll('time')].every((node) => {
						const time = node.getBoundingClientRect();
						return time.top >= bounds.top - 1 && time.bottom <= bounds.bottom + 1;
					});
				})
			)
			.toBe(true);
		await expect
			.poll(async () => grid.evaluate((el) => el.getBoundingClientRect().width))
			.toBeLessThanOrEqual(viewport.width);
		await expect
			.poll(() =>
				grid.evaluate((el) => {
					function measure(id: string) {
						const item = el.querySelector('[data-section-id="player-' + id + '"]')!;
						const region = item.getBoundingClientRect();
						const glyph = item.querySelector('.glyph')!.getBoundingClientRect();
						return { width: region.width, height: region.height, icon: glyph.width };
					}
					const next = measure('next'),
						play = measure('toggle');
					return Math.max(
						Math.abs(next.width - play.width),
						Math.abs(next.icon - (Math.min(next.width, next.height) - 10)),
						Math.abs(play.icon - Math.min(42, play.width, play.height))
					);
				})
			)
			.toBeLessThan(1);
	}
	for (const value of [3, 5]) {
		await grid.getByRole('button', { name: 'Rate ' + value + ' stars' }).click();
		await expect.poll(() => feedback.ratings.t0).toBe(value);
	}
	await grid.getByRole('button', { name: 'Lyrics', exact: true }).click();
	await expect(grid.getByText('First line', { exact: true })).toBeVisible();
	await grid.getByRole('button', { name: 'Lyrics', exact: true }).click();
	await expect(grid.getByText('First line', { exact: true })).toHaveCount(0);
	await grid.getByRole('button', { name: 'Show play queue' }).click();
	await expect(live.getByRole('heading', { name: 'Play queue' })).toBeVisible();
	await live.getByRole('button', { name: 'Hide play queue' }).click();
	await expect(grid).toBeVisible();
});

test('the layout editor and Preview keep live player proportions and all five stars after rotation', async ({
	page
}) => {
	const device = await page.context().newCDPSession(page);
	await device.send('Emulation.setSafeAreaInsetsOverride', {
		insets: { top: 26, bottom: 18, left: 12, right: 4 }
	});
	await fixture(page);
	await play(page);
	await page.evaluate((server) => {
		const layout = [
			['title', 0, 0, 12, 2],
			['settings', 12, 0, 3, 2],
			['rating', 0, 2, 7, 1]
		].map(([id, x, y, w, h]) => ({
			id: 'player-' + id,
			title: '',
			preview: true,
			grid: { x, y, w, h }
		}));
		localStorage.setItem(
			'dn.mobile.layout.v1.' + JSON.stringify([server, 'alex', 'player']),
			JSON.stringify(layout)
		);
		window.dispatchEvent(
			new CustomEvent('dn-layout-change', { detail: { board: 'player', user: 'alex', server } })
		);
	}, server);
	const live = page.locator('[data-part=now-playing]');
	async function measure(player: Locator) {
		const grid = player.locator('[data-player-grid]');
		await expect(grid.locator('.stars svg')).toHaveCount(5);
		return grid.evaluate(async (el) => {
			// Orientation changes trigger ResizeObserver in both the live player and draft canvases.
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			);
			const canvas = el.getBoundingClientRect();
			const tile = el
				.querySelector('[data-section-id=player-rating] .content')!
				.getBoundingClientRect();
			const glyphs = Array.from(el.querySelectorAll('.stars svg'), (node) =>
				node.getBoundingClientRect()
			);
			const title = el
				.querySelector('[data-section-id=player-title] .lines')!
				.getBoundingClientRect();
			return {
				ratio: canvas.width / canvas.height,
				star: glyphs[0].width / canvas.width,
				title: title.height / canvas.height,
				visible: glyphs.every(
					(g) =>
						g.width > 0 &&
						g.height > 0 &&
						g.left >= tile.left - 0.5 &&
						g.right <= tile.right + 0.5 &&
						g.top >= tile.top - 0.5 &&
						g.bottom <= tile.bottom + 0.5
				)
			};
		});
	}
	const sizes = [
		{ width: 390, height: 844 },
		{ width: 740, height: 360 }
	];
	const liveSizes = [];
	for (const size of sizes) {
		await page.setViewportSize(size);
		liveSizes.push(await measure(live));
	}
	await openEditor(page);
	for (const [i, size] of sizes.entries()) {
		await page.setViewportSize(size);
		const editor = await measure(page.locator('[data-part=sample-player]'));
		await editorButton(page, 'Preview current draft').click();
		const preview = await measure(page.locator('[data-part=draft-player]'));
		for (const surface of [editor, preview]) {
			expect(surface.ratio).toBeCloseTo(liveSizes[i].ratio, 2);
			expect(surface.star).toBeCloseTo(liveSizes[i].star, 3);
			expect(surface.title).toBeCloseTo(liveSizes[i].title, 3);
			expect(surface.visible).toBe(true);
		}
		expect(liveSizes[i].visible).toBe(true);
		await editorButton(page, 'Back to editing').click();
	}
	await device.detach();
});
