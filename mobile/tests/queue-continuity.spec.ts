import { expect, test } from '@playwright/test';
import { silentWav } from './fixtures/silentWav';
import { resolve } from 'node:path';
import type { PlaybackBridge, PlayerTrack } from '../src/lib/player';

declare global {
	interface Window {
		continuityPlayer: PlaybackBridge;
		continuityTracks: PlayerTrack[];
	}
}
const server = 'https://continuity.example/dn';
const access = { serverUrl: server, token: 'test', userId: 'one' };

let bundle = '';
test.beforeAll(async () => {
	const { build } = await import('vite');
	const built = await build({
		configFile: false,
		logLevel: 'silent',
		build: {
			write: false,
			lib: {
				entry: resolve('src/lib/player/browser.ts'),
				formats: ['es'],
				fileName: 'queue-fixture'
			},
			rollupOptions: { output: { inlineDynamicImports: true } }
		}
	});
	const output = Array.isArray(built) ? built[0] : built;
	if (!('output' in output) || output.output[0].type !== 'chunk')
		throw Error('Missing browser player fixture.');
	bundle = output.output[0].code;
});
test.beforeEach(async ({ page }) => {
	await page.route('**/queue-fixture.js', (route) =>
		route.fulfill({ contentType: 'application/javascript', body: bundle })
	);
	await page.route(server + '/api/v3/stream/local/**', (route) =>
		route.fulfill({
			contentType: 'audio/wav',
			body: silentWav()
		})
	);
	await page.goto('/');
	await page.evaluate(async (server) => {
		const source = '/queue-fixture.js';
		window.continuityPlayer = (await import(source)).browserPlayer();
		window.continuityTracks = ['one', 'two', 'one', 'three', 'four'].map((id, occurrence) => ({
			id,
			title: String(occurrence),
			artist: 'Artist',
			album: 'Album',
			duration: 60,
			genre: 'Jazz',
			recordingMbid: '10000000-0000-0000-0000-00000000000' + (id === 'one' ? 0 : occurrence),
			streamUrl: server + '/api/v3/stream/local/' + id
		}));
	}, server);
});
test('shuffle keeps the active occurrence and a paused replacement can restore its previous queue', async ({
	page
}) => {
	const result = await page.evaluate(async (access) => {
		const p = window.continuityPlayer,
			tracks = window.continuityTracks;
		await p.setQueue({ ...access, tracks, index: 0, playing: false });
		await p.command({ action: 'shuffleUpcoming' });
		const order = (await p.getState()).tracks.map((t) => t.title);
		await p.command({ action: 'skipTo', value: order.indexOf('2') });
		await p.command({ action: 'toggle' });
		await p.command({ action: 'seek', value: 0.05 });
		const original = await p.command({ action: 'shuffleUpcoming' });
		await p.setQueue({ ...access, tracks: [tracks[3]], index: 0, playing: false });
		const restored = await p.command({ action: 'restorePreviousQueue' });
		await p.setQueue({ ...access, userId: 'other', tracks: [tracks[3]], index: 0, playing: false });
		return { order, original, restored, other: await p.getState() };
	}, access);
	expect(result.order).not.toEqual(['0', '1', '2', '3', '4']);
	for (const s of [result.original, result.restored]) {
		expect(s.tracks.map((t) => t.title)).toEqual(['0', '1', '2', '3', '4']);
		expect(s.index).toBe(2);
		expect(s.playing).toBe(false);
		expect(s.position).toBeCloseTo(0.05);
	}
	expect(result.other.hasPreviousQueue).toBe(false);
});

test('Up Next keeps picked occurrences in order through shuffle, previous queue and playback', async ({
	page
}) => {
	const result = await page.evaluate(async (access) => {
		const p = window.continuityPlayer,
			[one, two, duplicate, three, four] = window.continuityTracks;
		const queue = async (tracks: PlayerTrack[], placement?: 'next' | 'upNext') =>
			p.setQueue({ ...access, tracks, placement, index: 0, playing: false });
		const snapshot = async () => {
			const s = await p.getState();
			return {
				titles: s.tracks.map((t) => t.title),
				picked: (s.upNext ?? []).map((i) => s.tracks[i].title)
			};
		};
		await queue([one, two, three, four]);
		await queue([duplicate], 'upNext');
		await queue([duplicate], 'upNext');
		await queue([four], 'next');
		const inserted = await snapshot();
		await p.command({ action: 'prioritize', value: 5 });
		await p.command({ action: 'shuffleUpcoming' });
		const shuffled = await snapshot();
		await queue([three]);
		await p.command({ action: 'restorePreviousQueue' });
		const restored = await snapshot();
		await p.command({ action: 'shuffleUpcoming' });
		await p.command({ action: 'skipTo', value: 2 });
		await p.command({ action: 'skipTo', value: 0 });
		const consumed = await snapshot();
		await p.command({ action: 'clearUpcoming' });
		return { inserted, shuffled, restored, consumed, cleared: await snapshot() };
	}, access);
	expect(result.inserted.titles).toEqual(['0', '4', '2', '2', '1', '3', '4']);
	expect(result.inserted.picked).toEqual(['4', '2', '2']);
	expect(result.shuffled.picked).toEqual(['4', '2', '2', '3']);
	expect(result.shuffled.titles.slice(1, 5)).toEqual(result.shuffled.picked);
	expect(result.restored).toEqual(result.shuffled);
	expect(result.consumed.picked).toEqual(['2', '3']);
	expect(result.cleared).toEqual({ titles: ['0'], picked: [] });
});

test('two possible upcoming orders alternate for one listener and undo preserves the queue', async ({
	page
}) => {
	const orders = await page.evaluate(async (account) => {
		const player = window.continuityPlayer;
		const [first, second, , third] = window.continuityTracks;
		const tracks = [first, second, third];
		const start = async (userId: string) => {
			await player.setQueue({ ...account, userId, tracks, index: 0, playing: false });
			const order = await player.command({ action: 'shuffleUpcoming' });
			const undone = await player.command({ action: 'shuffleUpcoming' });
			return [order.tracks.map((t) => t.id), undone.tracks.map((t) => t.id)];
		};
		return [
			await start(account.userId),
			await start('another listener'),
			await start(account.userId)
		];
	}, access);
	const original = ['one', 'two', 'three'];
	expect(orders[0][0]).toEqual(['one', 'three', 'two']);
	expect(orders[1][0]).toEqual(orders[0][0]);
	expect(orders[2][0]).toEqual(original);
	expect(orders.map(([, undone]) => undone)).toEqual([original, original, original]);
});

test('autoplay asks DN for fresh local recordings and cancels a pending plan on pause', async ({
	page
}) => {
	const plans: unknown[] = [];
	await page.route(server + '/api/v3/discover/radio/plan', async (route) => {
		plans.push(route.request().postDataJSON());
		const row = {
			artist_name: 'Artist',
			artist_mbid: '10000000-0000-0000-0000-000000000005',
			track_name: 'Fresh',
			in_library: true,
			local_file_id: 'fresh',
			recording_mbid: '20000000-0000-0000-0000-000000000004'
		};
		await route.fulfill({
			json: {
				tracks: [
					{ ...row, local_file_id: 'one' },
					{
						...row,
						local_file_id: 'alternate',
						recording_mbid: '10000000-0000-0000-0000-000000000000'
					},
					{ ...row, in_library: false, local_file_id: 'remote' },
					row,
					row
				]
			}
		});
	});
	const first = await page.evaluate(async (access) => {
		const p = window.continuityPlayer,
			tracks = window.continuityTracks;
		await p.setQueue({ ...access, tracks, index: 4, playing: false });
		const off = await p.command({ action: 'next' });
		await p.command({ action: 'setAutoplay', value: 1 });
		const on = await p.command({ action: 'next' });
		return { off, on };
	}, access);
	expect(first.off.tracks).toHaveLength(5);
	expect(first.on.tracks.map((t) => t.id)).toEqual(['one', 'two', 'one', 'three', 'four', 'fresh']);
	expect(first.on.index).toBe(5);
	expect(plans).toHaveLength(1);
	expect(plans[0]).toMatchObject({
		seed_type: 'genre',
		seed_id: 'Jazz',
		mode: 'library',
		count: 25
	});
	await page.route(server + '/api/v3/discover/radio/plan', (route) => {
		plans.push(route.request().postDataJSON());
		return new Promise<void>((resolve) =>
			setTimeout(() => {
				void route
					.fulfill({ json: { tracks: [] } })
					.catch(() => {})
					.finally(resolve);
			}, 300)
		);
	});
	await page.evaluate(() => {
		void window.continuityPlayer.command({ action: 'next' });
	});
	await expect.poll(() => plans.length).toBe(2);
	const last = await page.evaluate(async () => {
		const p = window.continuityPlayer;
		await p.command({ action: 'setPlaying', value: 0 });
		return p.getState();
	});
	expect(last.playing).toBe(false);
	expect(last.autoplayProblem).toBeUndefined();
});

test('signal path distinguishes the requested profile, live conversion and an original fallback', async ({
	page
}) => {
	await page.evaluate((access) => {
		const profile = { format: 'opus', rate: 96 };
		localStorage.setItem(
			'dn.mobile.stream.v2.' + JSON.stringify([access.serverUrl, access.userId]),
			JSON.stringify({ wifi: profile, cellular: profile })
		);
	}, access);
	let denyConversion = false;
	await page.route(server + '/api/v3/stream/local/**', (route) => {
		const requested = new URL(route.request().url()).searchParams.get('format');
		if (denyConversion && requested === 'opus') return route.fulfill({ status: 409 });
		return route.fulfill({
			body: silentWav(),
			contentType: 'audio/wav',
			headers: {
				'Access-Control-Expose-Headers': 'Accept-Ranges',
				'Accept-Ranges': requested === 'raw' ? 'bytes' : 'none'
			}
		});
	});
	const play = () =>
		page.evaluate(async (access) => {
			const p = window.continuityPlayer;
			await p.setQueue({ ...access, tracks: window.continuityTracks, index: 0 });
			return p.command({ action: 'setPlaying', value: 0 });
		}, access);
	const converted = await play();
	expect(converted.delivery).toMatchObject({
		source: 'network',
		requestedFormat: 'opus',
		requestedRate: 96,
		response: 'converted'
	});
	expect(converted.quality?.format).toBe('PCM');
	denyConversion = true;
	const fallback = await play();
	expect(fallback.delivery).toMatchObject({
		source: 'network',
		requestedFormat: 'opus',
		requestedRate: 96,
		response: 'fallback'
	});
	expect(fallback.quality?.format).toBe('PCM');
});

test('offline listening and a DN without radio keep the completed queue available', async ({
	page,
	context
}) => {
	let requests = 0;
	await page.route(server + '/api/v3/discover/radio/plan', (route) => {
		requests++;
		return route.fulfill({ status: 404, json: {} });
	});
	await page.evaluate(async (access) => {
		const p = window.continuityPlayer;
		await p.setQueue({ ...access, tracks: window.continuityTracks, index: 4, playing: false });
		await p.command({ action: 'setAutoplay', value: 1 });
	}, access);
	await context.setOffline(true);
	const offline = await page.evaluate(() => window.continuityPlayer.command({ action: 'next' }));
	expect(offline.autoplayProblem).toMatch(/online/i);
	expect(requests).toBe(0);
	await context.setOffline(false);
	const unsupported = await page.evaluate(() =>
		window.continuityPlayer.command({ action: 'retryAutoplay' })
	);
	expect(unsupported.autoplayProblem).toMatch(/404/);
	expect(unsupported.tracks).toHaveLength(5);
	expect(unsupported.index).toBe(4);
	expect(unsupported.playing).toBe(false);
	expect(requests).toBe(1);
});

test('the buffer follows the current transfer and only fills for a complete Blob', async ({
	page
}) => {
	const result = await page.evaluate(
		async ({ access, bytes }) => {
			const tracks = window.continuityTracks;
			const module = '/queue-fixture.js';
			const partial: number[] = [];
			let reached!: () => void;
			const started = () => new Promise<void>((resolve) => (reached = resolve));
			const player: PlaybackBridge = (await import(module)).browserPlayer(
				(state: import('../src/lib/player').PlayerState) => {
					if (state.bufferedRanges?.length) {
						partial.push(state.bufferedRanges[0].end);
						reached();
					}
				}
			);
			const wav = Uint8Array.from(bytes);
			const split = wav.length / 2;
			let finish!: () => void;
			let requests = 0;
			const fetch = window.fetch.bind(window);
			window.fetch = (input, init) => {
				if (!String(input).includes('/api/v3/stream/local/')) return fetch(input, init);
				requests++;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(wav.slice(0, split));
						finish = () => {
							controller.enqueue(wav.slice(split));
							controller.close();
						};
					}
				});
				return Promise.resolve(
					new Response(body, {
						headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) }
					})
				);
			};
			const half = started();
			const first = player.setQueue({ ...access, tracks, index: 0 });
			await half;
			const next = await player.setQueue({ ...access, tracks, index: 1, playing: false });
			finish();
			await first;
			const afterCancellation = await player.getState();
			const nextHalf = started();
			const second = player.setQueue({ ...access, tracks, index: 1 });
			await nextHalf;
			finish();
			const ready = await second;
			return {
				requests,
				partial,
				idle: next.bufferedRanges,
				cancelled: afterCancellation.bufferedRanges,
				index: afterCancellation.index,
				complete: ready.bufferedRanges,
				duration: ready.duration
			};
		},
		{ access, bytes: [...silentWav(0.1)] }
	);
	expect(result.requests).toBe(2);
	expect(result.partial).toEqual([30, 30]);
	expect(result.index).toBe(1);
	expect(result.idle).toEqual([]);
	expect(result.cancelled).toEqual([]);
	expect(result.complete).toEqual([{ start: 0, end: result.duration }]);
});
