import { minimizePlayer } from './fixtures/minimizePlayer';
import { chooseOption } from './fixtures/inlineChoice';
import { expect, test as base, type Page } from '@playwright/test';
import { touchRange } from './fixtures/touchRange';
import type { ManualStatus } from '../src/lib/offline/nativeMedia';
import {
	readPairing,
	recipient,
	sealToken
} from '../../frontend/src/routes/connect/mobile/handoff';

const test = base.extend<{ nativePlatform: 'android' | 'ios' }>({
	nativePlatform: ['android', { option: true }]
});
test.beforeEach(async ({ page, nativePlatform }) => {
	await page.addInitScript((platform) => {
		const listeners = new Map<string, (event: { url: string }) => void>();
		const plugins: Record<string, string[]> = {
			App: ['getLaunchUrl', 'addListener', 'removeListener'],
			Browser: ['open', 'close'],
			DNOutputs: ['choose'],
			SecureStorage: ['internalGetItem', 'internalSetItem', 'internalRemoveItem'],
			CapacitorHttp: ['request', 'get'],
			DNLauncher: [
				'takePlayerNotification',
				'pinPlaylist',
				'playlistPinned',
				'takePlaylist',
				'clearShortcuts'
			],
			DNOffline: [
				'snapshot',
				'options',
				'historySettings',
				'setOfflineHistory',
				'discardOfflineHistory',
				'manualStatus',
				'takeDownloadNotification',
				'downloadNotificationSettings',
				'openDownloadNotificationSettings',
				'enqueueManual',
				'cancelManual',
				'retryManual',
				'addListener',
				'removeListener',
				'cancelAutomatic',
				'resumeManual',
				'canSyncCollections',
				'planCollections',
				'configure',
				'save',
				'cancelTransfer'
			],
			DNPlayer: [
				'getEqualizer',
				'soundSettings',
				'autoplaySetting',
				'getTrackFade',
				'getStreamNetwork',
				'getState',
				'command',
				'restore',
				'outputState',
				'googleCast',
				'findOutputs',
				'castTo',
				'stopCasting'
			]
		};
		Object.assign(window, {
			...(platform === 'ios'
				? { webkit: { messageHandlers: { bridge: {} } } }
				: { androidBridge: {} }),
			deliverLink: (url: string) => listeners.get('appUrlOpen')?.({ url }),
			pressAndroidBack: () => listeners.get('backButton')?.({ url: '' }),
			Capacitor: {
				PluginHeaders: Object.entries(plugins).map(([name, methods]) => ({
					name,
					methods: methods.map((method) => ({
						name: method,
						rtype: method === 'addListener' ? 'callback' : 'promise'
					}))
				})),
				nativeCallback: (
					_plugin: string,
					_method: string,
					opts: { eventName: string },
					cb: (value: { url: string }) => void
				) => {
					listeners.set(opts.eventName, cb);
					return opts.eventName;
				},
				nativePromise: async (
					plugin: string,
					method: string,
					opts: Record<string, string> = {}
				) => {
					if (plugin === 'App') {
						if (method === 'getLaunchUrl' && sessionStorage.getItem('launch-url'))
							return { url: sessionStorage.getItem('launch-url') };
						if (method === 'removeListener') listeners.delete(opts.eventName);
						return undefined;
					}

					if (plugin === 'SecureStorage') {
						if (method === 'internalSetItem') sessionStorage.setItem(opts.prefixedKey, opts.data);
						if (method === 'internalRemoveItem') sessionStorage.removeItem(opts.prefixedKey);
						return { data: sessionStorage.getItem(opts.prefixedKey), success: true };
					}
					if (plugin === 'DNOffline') {
						if (
							method === 'downloadNotificationSettings' ||
							method === 'openDownloadNotificationSettings'
						) {
							if (Object.keys(opts).length)
								throw Error('Android notification settings need no account');
							if (method === 'downloadNotificationSettings')
								return { state: sessionStorage.getItem('notification-state') ?? 'appOff' };
							sessionStorage.setItem('opened-notification-settings', '1');
							return;
						}
						if (method === 'takeDownloadNotification') {
							if (Object.keys(opts).length) throw Error('A notification tap needs no account data');
							const open = sessionStorage.getItem('notification-tap') === '1';
							if (open) {
								sessionStorage.removeItem('notification-tap');
								sessionStorage.setItem(
									'notification-opens',
									String(Number(sessionStorage.getItem('notification-opens')) + 1)
								);
							}
							return { open };
						}
						if (['manualStatus', 'enqueueManual', 'retryManual', 'cancelManual'].includes(method)) {
							if (
								opts.serverUrl !== 'https://library.example/dn' ||
								opts.userId !== 'fixture-id' ||
								'token' in opts
							)
								throw Error('Wrong download account');
							const empty: ManualStatus = {
								state: 'idle',
								total: 0,
								saved: 0,
								pending: 0,
								failed: 0,
								lastError: ''
							};
							const before: ManualStatus =
								JSON.parse(sessionStorage.getItem('download-queue') ?? 'null') ?? empty;
							let status = before;
							if (method === 'enqueueManual') {
								const tracks = opts.tracks as unknown as { id: string; streamUrl: string }[];
								if (
									tracks.length !== 1 ||
									tracks[0].id !== 'saved' ||
									tracks[0].streamUrl !== '/api/v3/stream/local/saved'
								)
									throw Error('Invalid retained song');
								status = { ...empty, state: 'waitingOffline', pending: 1, total: 1 };
							}
							if (method === 'retryManual')
								status = {
									...empty,
									state: 'queued',
									total: before.total,
									pending: before.failed + before.pending,
									saved: before.saved
								};
							if (method === 'cancelManual') {
								status = empty;
								sessionStorage.setItem(
									'cancel-downloads',
									String(1 + Number(sessionStorage.getItem('cancel-downloads')))
								);
							}
							if (method !== 'manualStatus') {
								sessionStorage.setItem('download-queue', JSON.stringify(status));
								listeners.get('manualChanged')?.({ url: '' });
							}
							return method === 'enqueueManual'
								? {
										queued: before.pending ? 0 : 1,
										alreadyQueued: before.pending ? 1 : 0,
										saved: 0,
										failed: 0,
										status
									}
								: status;
						}
						if (method === 'canSyncCollections')
							return { permitted: sessionStorage.getItem('pin-network') !== 'blocked' };
						if (method === 'planCollections') {
							sessionStorage.setItem('planned-members', JSON.stringify(opts.members));
							return { ids: ['song-a', 'song-b'] };
						}
						if (method === 'save' && opts.collection) {
							const track = opts.track as unknown as { id: string };
							sessionStorage.setItem('saved-pin-' + track.id, 'yes');
							return;
						}
						const options = {
							offlinePins: JSON.parse(sessionStorage.getItem('fixture-pins') ?? '[]'),
							offlineOnly: sessionStorage.getItem('offline-only') === '1',
							autoDownload: 'off',
							downloadMiB: 512,
							autoCache: false,
							cacheMiB: 512,
							unmeteredOnly: true
						};
						if (method === 'options') return options;
						if (method === 'snapshot') return { items: [], options };
						if (
							['historySettings', 'setOfflineHistory', 'discardOfflineHistory'].includes(method)
						) {
							if (
								opts.serverUrl !== 'https://library.example/dn' ||
								opts.userId !== 'fixture-id' ||
								'token' in opts
							)
								throw Error('Unexpected offline history account');
							if (method === 'setOfflineHistory')
								sessionStorage.setItem('history-enabled', String(opts.enabled));
							if (method === 'discardOfflineHistory')
								sessionStorage.setItem('history-pending', '0');
							return {
								enabled: sessionStorage.getItem('history-enabled') !== 'false',
								pending: Number(sessionStorage.getItem('history-pending') ?? 2)
							};
						}
						return;
					}
					if (plugin === 'DNLauncher') {
						if (method === 'takePlayerNotification') {
							const open = sessionStorage.getItem('media-tap') === '1';
							sessionStorage.removeItem('media-tap');
							return { open };
						}
						if (
							opts.userId !== 'fixture-id' ||
							opts.serverUrl !== 'https://library.example/dn' ||
							'token' in opts
						)
							throw Error('Wrong shortcut account');
						if (method === 'playlistPinned')
							return { pinned: sessionStorage.getItem('pinned') === opts.id };
						if (method === 'pinPlaylist') {
							if (opts.remove) sessionStorage.removeItem('pinned');
							else sessionStorage.setItem('pinned', opts.id);
							return {};
						}
						if (method === 'clearShortcuts') {
							sessionStorage.removeItem('pinned');
							sessionStorage.removeItem('shortcut-launch');
							return {};
						}
						const id = sessionStorage.getItem('shortcut-launch');
						sessionStorage.removeItem('shortcut-launch');
						return { id };
					}
					if (plugin === 'DNOutputs' && method === 'choose') {
						sessionStorage.setItem('opened-airplay', '1');
						return;
					}
					if (plugin === 'Browser') {
						if (method === 'close') sessionStorage.setItem('browser-closed', '1');
						else sessionStorage.setItem('browser-url', opts.url);
						return;
					}
					if (plugin === 'DNPlayer') {
						if (method === 'getEqualizer')
							return {
								available: true,
								enabled: false,
								centers: [1000000],
								levels: [0],
								minimum: -1200,
								maximum: 1200,
								preset: ''
							};
						if (method === 'soundSettings') {
							if (opts.replayGain) sessionStorage.setItem('iphone-gain', opts.replayGain);
							return { speed: 1, replayGain: sessionStorage.getItem('iphone-gain') ?? 'off' };
						}
						if (method === 'getStreamNetwork') return { network: 'wifi' };
						if (method === 'getTrackFade') return { fadeInMs: 0, fadeOutMs: 0, smart: false };
						if (method === 'autoplaySetting') {
							if (opts.userId !== 'fixture-id') throw Error('Wrong autoplay account');
							if (opts.enabled !== undefined)
								sessionStorage.setItem('iphone-autoplay', String(opts.enabled));
							return { enabled: sessionStorage.getItem('iphone-autoplay') === 'true' };
						}

						if (method === 'command' && opts.action === 'toggle')
							sessionStorage.setItem('toggled-playback', '1');
						if (method === 'findOutputs') {
							sessionStorage.setItem('cast-search', 'yes');
							return { devices: [{ id: 'mock-renderer', name: 'Fixture receiver' }] };
						}
						if (method === 'castTo') {
							if (Object.keys(opts).join() !== 'id' || opts.id !== 'mock-renderer')
								throw Error('Invalid receiver');
							sessionStorage.setItem('receiver', 'Fixture receiver');
						}
						if (method === 'googleCast') sessionStorage.setItem('receiver', 'Fixture Chromecast');
						if (method === 'stopCasting') sessionStorage.removeItem('receiver');
						if (['outputState', 'castTo', 'googleCast', 'stopCasting'].includes(method))
							return { destination: sessionStorage.getItem('receiver') ?? '' };
						const track = sessionStorage.getItem('restored-song');
						return {
							repeat: 'off',
							tracks: track
								? [
										{
											id: 'saved',
											title: track,
											artist: 'Strings',
											album: 'Nightfall',
											streamUrl: '/api/v3/stream/local/saved'
										}
									]
								: [],
							index: track ? 0 : -1,
							playing: false,
							position: track ? 41 : 0,
							duration: track ? 120 : 0,
							error: null
						};
					}
					if (plugin === 'CapacitorHttp') {
						let data;
						const stock = new URL(opts.url).hostname === 'stock.example';
						if (opts.url.endsWith('/auth/providers'))
							data = { local: stock, oidc: true, jellyfin: false, plex: false };
						else if (opts.url.endsWith('/mobile-pairing.json')) {
							if (stock)
								return {
									status: 200,
									headers: { 'Content-Type': 'text/html' },
									data: '<!doctype html><html><title>DroppedNeedle</title></html>'
								};
							data = { droppedneedle_mobile_pairing: 1 };
						} else if (opts.url.endsWith('/me')) {
							if (sessionStorage.getItem('proxy-denied'))
								return { status: 401, headers: { 'Content-Type': 'text/html' }, data: '' };
							if (sessionStorage.getItem('hold-profile')) {
								await new Promise<void>((resolve) => {
									window.addEventListener('release-profile', () => resolve(), { once: true });
								});
							}
							if (!sessionStorage.getItem('reconnected')) throw new Error('Server unreachable.');
							data = { id: 'fixture-id', display_name: 'Listener' };
						} else if (opts.url.endsWith('/auth/logout')) {
							if (sessionStorage.getItem('logout-unconfirmed')) throw Error('Connection lost.');
							sessionStorage.setItem('revoked-device', '1');
							return { status: 204, headers: {}, data: null };
						} else if (opts.url.endsWith('/me/section-prefs'))
							data = { pages: { home: [], discover: [] } };
						else if (
							opts.method === 'GET' &&
							(opts.url.endsWith('/home') || opts.url.endsWith('/discover'))
						)
							data = { sections: [] };
						else if (opts.url.endsWith('/playlists'))
							data = {
								playlists: [
									{
										id: 'night',
										name: 'Night drive',
										cover_urls: [],
										track_count: 0,
										is_owner: true
									}
								]
							};
						else if (opts.url.endsWith('/playlists/night'))
							data = {
								id: 'night',
								name: 'Night drive',
								cover_urls: [],
								track_count: 0,
								is_owner: true,
								is_redacted: false,
								tracks: []
							};
						else if (
							sessionStorage.getItem('fixture-pins') &&
							opts.url.includes('/library/tracks?')
						) {
							const query = new URL(opts.url).searchParams;
							let ids = ['song-a'];
							if (query.has('artist_id')) ids = ['song-a', 'song-b'];
							data = {
								items: ids.map((id) => ({
									id,
									title: id,
									artist_name: 'Dawn',
									album_title: 'Night',
									album_id: 'a'
								})),
								total: ids.length,
								next: null
							};
						} else if (opts.url.includes('/library/albums')) data = { items: [], next: null };
						else throw new Error('Unexpected test request.');
						return { status: 200, headers: { 'Content-Type': 'application/json' }, data };
					}
					throw new Error('Unexpected native call.');
				}
			}
		});
		window.addEventListener('fixture-system-resume', () => listeners.get('resume')?.({ url: '' }));
		window.addEventListener('fixture-download-update', () =>
			listeners.get('manualChanged')?.({ url: '' })
		);
	}, nativePlatform);
});

test('Android explains how to enable OIDC pairing before asking for local credentials on a stock server', async ({
	page
}) => {
	await page.goto('/');
	await page.getByLabel('Server address').fill('https://stock.example/music');
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	const guidance = page.getByRole('paragraph').filter({ hasText: 'ask your administrator' });
	await expect(guidance).toContainText('single sign-on (OIDC)');
	await expect(guidance).toContainText('web frontend with mobile pairing');
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	await page.getByRole('button', { name: 'Open web player' }).click();
	expect(await page.evaluate(() => sessionStorage.getItem('browser-url'))).toBe(
		'https://stock.example/music/'
	);
	await page.getByRole('button', { name: 'Use DroppedNeedle password' }).click();
	await expect(page.getByLabel('DroppedNeedle username')).toBeVisible();
	await expect(page.getByLabel('DroppedNeedle password')).toBeVisible();
	await expect(guidance).toBeVisible();
});

async function deliverApproval(page: Page, cold = false) {
	await page.goto('/');
	await page.getByLabel('Server address').fill('https://library.example/dn');
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByRole('button', { name: 'Continue in browser' }).click();
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem('browser-url')))
		.not.toBeNull();
	const launched = await page.evaluate(() => sessionStorage.getItem('browser-url'));
	const pairing = readPairing(new URL(launched!).searchParams)!;
	const reply = await sealToken(pairing, await recipient(pairing), 'synthetic-device-session');
	if (cold) {
		await page.evaluate((url) => sessionStorage.setItem('launch-url', url), reply);
		await page.reload();
	} else {
		await page.evaluate((url) => {
			(window as unknown as { deliverLink(url: string): void }).deliverLink(url);
		}, reply);
	}
	return launched;
}

test('Android media notification opens the paused player on cold and warm taps', async ({
	page
}) => {
	await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
	await deliverApproval(page);
	await page.evaluate(() => {
		sessionStorage.setItem('restored-song', 'Night service');
		sessionStorage.setItem('media-tap', '1');
	});
	await page.reload();
	const active = page.getByRole('region', { name: 'Now playing', exact: true });
	await expect(active).toBeVisible();
	await minimizePlayer(page);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.evaluate(() => window.dispatchEvent(new Event('dn-player-notification')));
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
	await page.evaluate(() => {
		sessionStorage.setItem('media-tap', '1');
		window.dispatchEvent(new Event('dn-player-notification'));
	});
	await expect(active).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('toggled-playback'))).toBeNull();
});

test('a download notification waits for browser sign-in and opens Offline music only once per tap', async ({
	page
}) => {
	await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
	await page.goto('/');
	await page.evaluate(() => sessionStorage.setItem('notification-tap', '1'));
	await expect(page.getByLabel('Server address')).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new Event('dn-download-notification')));
	expect(await page.evaluate(() => sessionStorage.getItem('notification-tap'))).toBe('1');
	await deliverApproval(page);
	const heading = (name: string) => page.getByRole('heading', { name, exact: true });
	await expect(heading('Offline music')).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('notification-opens'))).toBe('1');

	// A cold notification overrides this listener's saved Now Playing screen for this launch.
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Navigation bar and start screen', exact: true }).click();
	await chooseOption(page.getByLabel('Start screen'), 'player');
	await page.evaluate(() => {
		sessionStorage.setItem('restored-song', 'Night service');
		sessionStorage.setItem('notification-tap', '1');
	});
	await page.reload();
	await expect(heading('Offline music')).toBeVisible();
	await page.reload();
	await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();

	// A warm tap leaves the restored song paused and takes the listener out of Settings.
	await minimizePlayer(page);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(heading('Settings')).toBeVisible();
	await page.evaluate(() => {
		sessionStorage.setItem('notification-tap', '1');
		window.dispatchEvent(new Event('dn-download-notification'));
	});
	await expect(heading('Offline music')).toBeVisible();
	await expect(heading('Settings')).toHaveCount(0);
	expect(await page.evaluate(() => sessionStorage.getItem('notification-opens'))).toBe('3');
	expect(await page.evaluate(() => sessionStorage.getItem('toggled-playback'))).toBeNull();
	await page.getByRole('button', { name: 'Home', exact: true }).click();
	await page.evaluate(() => window.dispatchEvent(new Event('dn-download-notification')));
	await expect(heading('Home')).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('notification-opens'))).toBe('3');
});

test('pinning a playlist opens its detail on cold and warm Android launcher taps', async ({
	page
}) => {
	await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
	await deliverApproval(page);
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	await button('Library').click();
	await button('Browse Playlists').click();
	await button('More options for Night drive').click();
	await button('Add Android launcher shortcut').click();
	await expect(page.getByText('Confirm the playlist shortcut in your launcher.')).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('pinned'))).toBe('playlist:night');
	await page.evaluate(() => sessionStorage.setItem('shortcut-launch', 'playlist:night'));
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Night drive' })).toBeVisible();
	await button('Home').click();
	await page.evaluate(() => {
		sessionStorage.setItem('shortcut-launch', 'playlist:night');
		window.dispatchEvent(new Event('dn-playlist-shortcut'));
	});
	await expect(page.getByRole('heading', { name: 'Night drive' })).toBeVisible();
});

test('the chosen start screen works offline and opens a restored song without starting playback', async ({
	page
}) => {
	await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
	await deliverApproval(page);
	const heading = (name: string) => page.getByRole('heading', { name, exact: true });
	const openInterface = async () => {
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page
			.getByRole('button', { name: 'Navigation bar and start screen', exact: true })
			.click();
	};
	await expect(heading('Home')).toBeVisible();
	await openInterface();
	const start = page.getByLabel('Start screen');
	await expect(start).toHaveAttribute('data-value', 'automatic');
	await chooseOption(start, 'player');
	await page.reload();
	await expect(heading('Library')).toBeVisible();
	await page.evaluate(() => {
		sessionStorage.setItem('restored-song', 'Night service');
		sessionStorage.setItem('offline-only', '1');
	});
	await page.reload();
	const player = page.getByRole('region', { name: 'Now playing' });
	await expect(player).toBeVisible();
	await expect(player.getByText('Night service', { exact: true }).first()).toBeVisible();
	await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('toggled-playback'))).toBeNull();
	await minimizePlayer(page);
	await expect(heading('Library')).toBeVisible();
	await openInterface();
	await chooseOption(start, 'library');
	await page.reload();
	await expect(heading('Library')).toBeVisible();
	await openInterface();
	await chooseOption(start, 'home');
	await page.reload();
	await expect(heading('Home')).toBeVisible();
	await openInterface();
	await page.getByRole('button', { name: 'Restore navigation defaults' }).click();
	await page.reload();
	await expect(heading('Offline music')).toBeVisible();
});

test('download notification settings open on demand and reflect Android changes on return', async ({
	page
}) => {
	await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
	await deliverApproval(page);
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Download preferences', exact: true }).click();
	const group = page.getByRole('group', { name: 'Download notifications' });
	await expect(group.getByRole('status')).toHaveText('Off for DroppedNeedle.');
	expect(
		await page.evaluate(() => sessionStorage.getItem('opened-notification-settings'))
	).toBeNull();
	await group.getByRole('button', { name: 'Open Android notification settings' }).click();
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem('opened-notification-settings')))
		.toBe('1');
	for (const [state, text] of [
		[
			'appOn',
			'On for DroppedNeedle. The download channel appears after your first download starts.'
		],
		['channelOff', 'Off for offline downloads.'],
		['on', 'On for offline downloads.']
	]) {
		await page.evaluate((value) => {
			sessionStorage.setItem('notification-state', value);
			window.dispatchEvent(new Event('fixture-system-resume'));
		}, state);
		await expect(group.getByRole('status')).toHaveText(text);
	}
});

test('Android offline history settings preserve pending listens until discard is confirmed', async ({
	page
}) => {
	await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
	await deliverApproval(page);
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByRole('button', { name: 'Offline listening history', exact: true }).click();
	const history = page.getByRole('group', { name: 'Offline listening history' }),
		enabled = history.getByLabel('Record offline listens');
	await expect(enabled).toBeChecked();
	await expect(history.getByText('2 listens waiting to sync.')).toBeVisible();
	await enabled.uncheck();
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem('history-enabled')))
		.toBe('false');
	await history.getByRole('button', { name: 'Discard pending listens' }).click();
	await history.getByRole('button', { name: 'Cancel' }).click();
	await expect(history.getByText('2 listens waiting to sync.')).toBeVisible();
	await history.getByRole('button', { name: 'Discard pending listens' }).click();
	await history.getByRole('button', { name: 'Confirm discard' }).click();
	await expect(history.getByText('Pending listens discarded.')).toBeVisible();
	await expect(history.getByRole('button', { name: 'Discard pending listens' })).toHaveCount(0);
	await enabled.check();
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem('history-enabled')))
		.toBe('true');
});

test('queued Android downloads survive navigation and expose waiting, retry and cancel in Offline music', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 760 });
	await page.addInitScript(() => {
		sessionStorage.setItem('reconnected', '1');
		sessionStorage.setItem('restored-song', 'Night service');
		sessionStorage.setItem('offline-only', '1');
	});
	await deliverApproval(page);
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	const queue = page.getByRole('region', { name: 'Download queue' });
	await expect(page.getByRole('heading', { name: 'Offline music', exact: true })).toBeVisible();
	await expect(queue).toHaveCount(0);
	await button('Open player for Night service').click();
	await page.getByRole('button', { name: 'More actions', exact: true }).click();
	await button('Queue for download').click();
	await expect(
		page.getByRole('status').filter({ hasText: '1 song queued for download.' })
	).toBeVisible();
	await button('Queue for download').click();
	await expect(
		page.getByRole('status').filter({ hasText: '1 song already in the download queue.' })
	).toBeVisible();
	await button('View download queue').click();
	await expect(queue.getByRole('status')).toContainText('Waiting for offline-only playback');
	await page.reload();
	await expect(queue.getByRole('status')).toContainText('0 of 1 saved');
	await page.evaluate(() => {
		sessionStorage.setItem(
			'download-queue',
			JSON.stringify({
				state: 'downloading',
				total: 1,
				pending: 1,
				failed: 0,
				saved: 0,
				lastError: '',
				current: { id: 'saved', title: 'Night service', artist: 'Strings' }
			})
		);
		window.dispatchEvent(new Event('fixture-download-update'));
	});
	await expect(queue.getByText('Night service · Strings', { exact: true })).toBeVisible();
	await page.evaluate(() => {
		sessionStorage.setItem(
			'download-queue',
			JSON.stringify({
				state: 'failed',
				total: 1,
				pending: 0,
				failed: 1,
				saved: 0,
				lastError: 'File unavailable on DN.',
				failures: [
					{
						id: 'saved',
						title: 'Night service',
						artist: 'Strings',
						reason: 'File unavailable on DN.'
					}
				]
			})
		);
		window.dispatchEvent(new Event('fixture-download-update'));
	});
	await expect(
		queue.getByRole('list', { name: 'Failed songs' }).getByText('File unavailable on DN.')
	).toBeVisible();
	await button('Retry failed downloads').click();
	await expect(queue.getByRole('status')).toContainText('Queued for download');
	await button('Cancel remaining downloads').click();
	await expect(queue).toHaveCount(0);
	await page.evaluate(() => {
		sessionStorage.setItem(
			'download-queue',
			JSON.stringify({
				state: 'complete',
				total: 1,
				pending: 0,
				failed: 0,
				saved: 1,
				lastError: ''
			})
		);
		window.dispatchEvent(new Event('fixture-download-update'));
	});
	await expect(queue.getByRole('status')).toContainText('Downloads complete · 1 of 1 saved');
	await button('Dismiss download summary').click();
	await expect(queue).toHaveCount(0);
	await button('Settings').click();
	await button('Sign out').click();
	await expect(page.getByLabel('Server address')).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('cancel-downloads'))).toBe('3');
});

test('an Android listener chooses and disconnects a network output after browser sign-in', async ({
	page
}) => {
	await page.addInitScript(() => {
		sessionStorage.setItem('reconnected', '1');
		sessionStorage.setItem('restored-song', 'Night service');
		localStorage.setItem('dn.mobile.interface.v2', JSON.stringify({ surface: 'glass' }));
	});
	await deliverApproval(page);
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	const menu = page.getByRole('heading', { name: 'Settings', exact: true });
	const output = page.getByRole('button', { name: 'Cast and audio output', exact: true });
	expect((await output.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await page.getByRole('button', { name: 'Cast and audio output' }).click();
	const sheet = page.getByRole('dialog', { name: 'Cast and audio output' });
	expect(await page.evaluate(() => sessionStorage.getItem('cast-search'))).toBeNull();
	await sheet.getByRole('button', { name: 'Find network speakers' }).click();
	await sheet.getByRole('button', { name: 'Fixture receiver' }).click();
	await expect(sheet.getByText('Casting to Fixture receiver')).toBeVisible();
	await sheet.getByRole('button', { name: 'Stop casting' }).click();
	await sheet.getByRole('button', { name: 'Choose Google Cast device' }).click();
	await expect(sheet.getByText('Casting to Fixture Chromecast')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(menu).toBeVisible();
	await page.getByRole('button', { name: 'Cast and audio output' }).click();
	await expect(sheet.getByText('Casting to Fixture Chromecast')).toBeVisible();
	await sheet.getByRole('button', { name: 'Stop casting' }).click();
	await expect(sheet.getByText('Playing on this phone')).toBeVisible();
	const androidBack = () =>
		page.evaluate(() => (window as unknown as { pressAndroidBack(): void }).pressAndroidBack());
	await androidBack();
	await expect(sheet).toHaveCount(0);
	await expect(output).toBeFocused();
	await androidBack();
	await expect(menu).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Open player for Night service' }).click();
	await expect(output).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await expect(output).toHaveCSS('background-image', 'none');
	await expect(output).toHaveCSS('box-shadow', 'none');
	await page.keyboard.press('Tab');
	await output.focus();
	await expect(output).toHaveCSS('outline-width', '3px');
	await output.click();
	await expect(output).toHaveAttribute('aria-expanded', 'true');
	await expect(sheet.getByRole('button', { name: 'Find network speakers' })).toHaveCSS(
		'background-image',
		/linear-gradient/
	);
});

test('Android can finish a returned browser sign-in after the network and app restart', async ({
	page
}) => {
	const launched = await deliverApproval(page);
	await expect(page.getByRole('alert')).toContainText('Server unreachable.');
	await page.evaluate(() => sessionStorage.setItem('reconnected', '1'));
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	expect(await page.evaluate(() => sessionStorage.getItem('browser-url'))).toBe(launched);
});

test('changing servers cancels profile verification already in flight', async ({ page }) => {
	await page.addInitScript(() => {
		sessionStorage.setItem('hold-profile', '1');
		sessionStorage.setItem('reconnected', '1');
	});
	await deliverApproval(page);
	await page.getByRole('button', { name: 'Change server' }).click();
	await expect(page.getByLabel('Server address')).toBeVisible();
	await page.evaluate(async () => {
		window.dispatchEvent(new Event('release-profile'));
		// The fixture bridge settles the request and storage calls in microtasks.
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});
	await expect(page.getByLabel('Server address')).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Server address')).toBeVisible();
	expect(
		await page.evaluate(() => sessionStorage.getItem('capacitor-storage_dn.mobile.session'))
	).toBeNull();
});

test('a sustained player swipe survives a native playback-state refresh', async ({ page }) => {
	await page.addInitScript(() => {
		sessionStorage.setItem('reconnected', '1');
		sessionStorage.setItem('restored-song', 'Night service');
		sessionStorage.setItem('offline-only', '1');
	});
	await deliverApproval(page);
	await page.getByRole('button', { name: 'Open player for Night service' }).click();
	const touch = await touchRange(page);
	try {
		const artwork = page.locator('[data-part=now-playing] .hero');
		const origin = await touch.point(artwork);
		await touch.hold(artwork);
		await touch.moveTo(origin.x, origin.y - 23);
		// This is the same refresh used by the foreground polling timer. The mock native bridge
		// supplies fresh track objects, just as Capacitor deserializes each Media3 snapshot.
		await page.evaluate(async () => {
			document.dispatchEvent(new Event('visibilitychange'));
			await new Promise<void>((done) =>
				requestAnimationFrame(() => requestAnimationFrame(() => done()))
			);
		});
		await touch.moveTo(origin.x, origin.y - 88);
		await touch.lift();
		await expect(page.getByRole('heading', { name: 'Play queue' })).toBeVisible();
	} finally {
		await touch.close();
	}
});

test.describe('iPhone integration', () => {
	test.use({ nativePlatform: 'ios' });
	test('iPhone exposes handoff, queue extension and native audio preferences', async ({ page }) => {
		await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
		await deliverApproval(page);
		await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
		const button = (name: string) => page.getByRole('button', { name, exact: true });
		await button('Settings').click();
		await expect(button('Player handoff')).toBeVisible();
		await button('Sound').click();
		await expect(page.getByRole('heading', { name: 'Frequency bands' })).toBeVisible();
		await button('Back').click();
		await page.getByRole('checkbox', { name: 'Autoplay when the queue ends' }).check();
		await expect
			.poll(() => page.evaluate(() => sessionStorage.getItem('iphone-autoplay')))
			.toBe('true');
		await button('Sound').click();
		await chooseOption(page.getByRole('combobox', { name: 'Volume normalization' }), 'album');
		await expect
			.poll(() => page.evaluate(() => sessionStorage.getItem('iphone-gain')))
			.toBe('album');
	});
	test('pinned collections sync together on an allowed network', async ({ page }) => {
		const pins = [
			{ kind: 'artist', id: 'artist-a', name: 'Dawn' },
			{ kind: 'recent', id: 'recent', name: 'Recent' }
		];
		await page.addInitScript((pins) => {
			sessionStorage.setItem('reconnected', '1');
			sessionStorage.setItem('fixture-pins', JSON.stringify(pins));
			sessionStorage.setItem('pin-network', 'blocked');
		}, pins);
		await deliverApproval(page);
		await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
		const button = (name: string) => page.getByRole('button', { name, exact: true });
		await button('Settings').click();
		await button('Download preferences').click();
		await expect(button('Stop keeping Dawn offline')).toBeVisible();
		expect(await page.evaluate(() => sessionStorage.getItem('planned-members'))).toBeNull();
		await page.evaluate(() => sessionStorage.setItem('pin-network', 'allowed'));
		await button('Update automatic downloads').click();
		await expect
			.poll(() => page.evaluate(() => sessionStorage.getItem('saved-pin-song-b')))
			.toBe('yes');
		const members = await page.evaluate(() =>
			JSON.parse(sessionStorage.getItem('planned-members')!)
		);
		expect(members).toEqual([
			{ ...pins[0], ids: ['song-a', 'song-b'], complete: true },
			{ ...pins[1], ids: ['song-a'], complete: true }
		]);
	});
	test('a returned OIDC session survives a network failure and a stale launch URL', async ({
		page
	}) => {
		await deliverApproval(page);
		await expect(page.getByRole('alert')).toContainText('Server unreachable.');
		expect(await page.evaluate(() => sessionStorage.getItem('browser-closed'))).toBe('1');
		await page.evaluate(() => {
			sessionStorage.setItem('launch-url', 'app.droppedneedle.mobile://connect#state=older');
			sessionStorage.setItem('reconnected', '1');
		});
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
	});
	test('the signed-in listener can open AirPlay and return to a pinned playlist', async ({
		page
	}) => {
		await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
		await deliverApproval(page, true);
		const button = (name: string) => page.getByRole('button', { name, exact: true });
		await button('Settings').click();
		await button('Cast and audio output').click();
		await expect
			.poll(() => page.evaluate(() => sessionStorage.getItem('opened-airplay')))
			.toBe('1');
		await page
			.locator('nav.shortcuts')
			.getByRole('button', { name: 'Library', exact: true })
			.click();
		await button('Browse Playlists').click();
		await button('More options for Night drive').click();
		await button('Add Home Screen quick action').click();
		await expect(
			page.getByText('Touch and hold DroppedNeedle on the Home Screen to open this playlist.')
		).toBeVisible();
		await page.evaluate(() => sessionStorage.setItem('shortcut-launch', 'playlist:night'));
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Night drive' })).toBeVisible();
		await button('Home').click();
		await page.evaluate(() => {
			sessionStorage.setItem('shortcut-launch', 'playlist:night');
			window.dispatchEvent(new Event('dn-playlist-shortcut'));
		});
		await expect(page.getByRole('heading', { name: 'Night drive' })).toBeVisible();
		await button('Back to playlists').click();
		await button('More options for Night drive').click();
		await button('Remove Home Screen quick action').click();
		await expect(page.getByText('Home Screen quick action removed.')).toBeVisible();
		await button('More options for Night drive').click();
		await button('Add Home Screen quick action').click();
		await button('Settings').click();
		await button('Sign out').click();
		await expect(page.getByLabel('Server address')).toBeVisible();
		await expect.poll(() => page.evaluate(() => sessionStorage.getItem('pinned'))).toBeNull();
	});
});

test('a proxy denial preserves the pairing reply for retry', async ({ page }) => {
	await page.addInitScript(() => {
		sessionStorage.setItem('proxy-denied', '1');
		sessionStorage.setItem('reconnected', '1');
	});
	await deliverApproval(page);
	const retry = page.getByRole('button', { name: 'Retry connection' });
	await expect(retry).toBeVisible();
	await page.evaluate(() => sessionStorage.removeItem('proxy-denied'));
	await retry.click();
	await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
});

test('unconfirmed device sign-out survives restart and retries on reconnect', async ({ page }) => {
	await page.addInitScript(() => sessionStorage.setItem('reconnected', '1'));
	await deliverApproval(page);
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.evaluate(() => sessionStorage.setItem('logout-unconfirmed', '1'));
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	const link = page.getByRole('button', { name: 'Manage server sessions' });
	await expect(link).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Server address')).toBeVisible();
	await expect(link).toBeVisible();
	await page.evaluate(() => {
		sessionStorage.removeItem('logout-unconfirmed');
		window.dispatchEvent(new Event('online'));
	});
	await expect.poll(() => page.evaluate(() => sessionStorage.getItem('revoked-device'))).toBe('1');
	await expect(link).toHaveCount(0);
});

test('slow native polls coalesce and compact updates keep the queue until its version changes', async ({
	page
}) => {
	await page.addInitScript(() => {
		sessionStorage.setItem('reconnected', '1');
		sessionStorage.setItem('restored-song', 'Night service');
	});
	await deliverApproval(page);
	await expect(page.getByRole('button', { name: 'Open player for Night service' })).toBeVisible();
	// Drive the same foreground refresh as the timer, holding the first native read
	// open across several ticks and changing metadata on a later native queue edit.
	await page.clock.install();
	await page.evaluate(() => {
		type Bridge = {
			nativePromise: (
				plugin: string,
				method: string,
				opts?: { knownQueue?: string }
			) => Promise<unknown>;
		};
		const bridge = (window as unknown as { Capacitor: Bridge }).Capacitor;
		const original = bridge.nativePromise.bind(bridge);
		let reads = 0;
		bridge.nativePromise = async (plugin, method, opts) => {
			if (plugin !== 'DNPlayer' || method !== 'getState') return original(plugin, method, opts);
			reads++;
			sessionStorage.setItem('poll-reads', String(reads));
			const queueVersion = sessionStorage.getItem('poll-version') ?? 'first';
			const snapshot = {
				queueVersion,
				playing: false,
				index: 0,
				position: 37,
				duration: 120,
				repeat: 'off',
				error: null
			};
			if (reads === 1 || queueVersion === 'superseded') {
				sessionStorage.setItem('waiting-poll', queueVersion);
				await new Promise<void>((done) =>
					window.addEventListener('release-poll', () => done(), { once: true })
				);
			}
			if (opts?.knownQueue === queueVersion) {
				sessionStorage.setItem('compact-poll', queueVersion);
				return { ...snapshot, playing: true };
			}
			return {
				...snapshot,
				tracks: Array.from({ length: 2000 }, (_, i) => ({
					id: String(i),
					title: queueVersion + ' recording ' + i,
					artist: 'Artist',
					album: 'Album',
					streamUrl: '/api/v3/stream/local/' + i
				}))
			};
		};
		for (let n = 0; n < 4; n++) document.dispatchEvent(new Event('visibilitychange'));
	});
	expect(await page.evaluate(() => sessionStorage.getItem('poll-reads'))).toBe('1');
	await page.evaluate(() => window.dispatchEvent(new Event('release-poll')));
	await expect(
		page.getByRole('button', { name: 'Open player for first recording 0' })
	).toBeVisible();
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem('compact-poll')))
		.toBe('first');
	await expect(
		page.getByRole('button', { name: 'Open player for first recording 0' })
	).toBeVisible();
	await page.evaluate(() => {
		sessionStorage.setItem('poll-version', 'edited');
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect(
		page.getByRole('button', { name: 'Open player for edited recording 0' })
	).toBeVisible();
	await page.evaluate(() => {
		sessionStorage.setItem('poll-version', 'superseded');
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect
		.poll(() => page.evaluate(() => sessionStorage.getItem('waiting-poll')))
		.toBe('superseded');
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Open player for Night service' })).toBeVisible();
	await page.evaluate(async () => {
		window.dispatchEvent(new Event('release-poll'));
		await new Promise<void>((done) => requestAnimationFrame(() => done()));
	});
	await expect(page.getByRole('button', { name: 'Open player for Night service' })).toBeVisible();
});
