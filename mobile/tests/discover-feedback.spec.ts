import { expect, test } from '@playwright/test';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';
import type { Feedback, Tuning } from '../src/lib/catalog/discoverFeedback';

// One second of silent PCM; the browser can really start this sample without using speakers.
function sampleAudio() {
	const wave = Buffer.alloc(44 + 8000);
	wave.write('RIFF');
	wave.writeUInt32LE(wave.length - 8, 4);
	wave.write('WAVEfmt ', 8);
	wave.writeUInt32LE(16, 16);
	wave.writeUInt16LE(1, 20);
	wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(8000, 24);
	wave.writeUInt32LE(8000, 28);
	wave.writeUInt16LE(1, 32);
	wave.writeUInt16LE(8, 34);
	wave.write('data', 36);
	wave.writeUInt32LE(8000, 40);
	wave.fill(128, 44);
	return wave;
}

test('Discover shares album and artist answers, seed tunings and undo with the server', async ({
	page
}) => {
	const server = 'https://dn.example/music';
	const first = '00000000-0000-4000-8000-000000000001';
	const second = '00000000-0000-4000-8000-000000000002';
	const artist = '00000000-0000-4000-8000-000000000003';
	const seed = '00000000-0000-4000-8000-000000000004';
	let feedback: Feedback[] = [];
	let tunings: Tuning[] = [];
	let deny = true;
	const observed: { release_group_mbid: string; event: string }[] = [];
	await page.addInitScript((server) => {
		localStorage.setItem(
			'dn.mobile.layout.v1.' + JSON.stringify([server, 'user', 'discover']),
			JSON.stringify([{ id: 'discover-discover_queue', preview: false }])
		);
	}, server);
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			path = new URL(req.url()).pathname.split('/api/v3/')[1];
		if (path === 'auth/providers')
			return route.fulfill({ json: { local: true, oidc: false, plex: false, jellyfin: false } });
		if (path === 'auth/login') return route.fulfill({ json: { token: 'token' } });
		if (path === 'me') return route.fulfill({ json: { id: 'user', display_name: 'Listener' } });
		if (path === 'discover')
			return route.fulfill({
				json: { sections: [], discover_queue_enabled: true, refreshing: false }
			});
		if (path === 'discover/queue')
			return route.fulfill({
				json: {
					queue_id: 'fixture',
					items: [first, second].map((id, i) => ({
						musicbrainz_id: id,
						artist_id: artist,
						artist_name: 'Cloud',
						title: i ? 'Valley' : 'Mountain',
						in_library: false,
						is_wildcard: false,
						recommendation_reason: 'A recommendation'
					}))
				}
			});
		if (path === 'discover/picks/events') {
			expect(req.method()).toBe('POST');
			observed.push(req.postDataJSON());
			return route.fulfill({ status: 204 });
		}
		if (path === 'library/albums/match/' + first) {
			return route.fulfill({
				json: { items: [{ id: 'song-id', title: 'First sample' }], total: 1 }
			});
		}
		if (path === 'stream/local/song-id') {
			expect(req.headers().range).toBe('bytes=0-2097151');
			expect(req.headers().authorization).toBe('Bearer token');
			return route.fulfill({ status: 206, contentType: 'audio/wav', body: sampleAudio() });
		}
		if (path === 'discover/feedback') {
			if (req.method() === 'GET') return route.fulfill({ json: { items: feedback } });
			const b = req.postDataJSON();
			expect(b).toEqual({
				kind: b.kind,
				release_group_mbid: first,
				artist_mbid: artist,
				release_name: 'Mountain',
				artist_name: 'Cloud',
				made_from: 'deck'
			});
			if (deny)
				return route.fulfill({ status: 403, json: { error: { message: 'Permission denied' } } });
			const row: Feedback = {
				kind: b.kind,
				target: b.kind === 'not_artist' ? 'artist' : 'album',
				target_mbid: b.kind === 'not_artist' ? artist : first,
				release_name: 'Mountain',
				artist_name: 'Cloud'
			};
			feedback = [row];
			return route.fulfill({ json: row });
		}
		if (path.startsWith('discover/feedback/')) {
			expect(req.method()).toBe('DELETE');
			expect(path).toBe('discover/feedback/' + feedback[0].target + '/' + feedback[0].target_mbid);
			feedback = [];
			return route.fulfill({ status: 204 });
		}
		if (path === 'discover/picks/' + first + '/why')
			return route.fulfill({
				json: {
					reason: { line: 'Because you listen to Coast.' },
					seeds: [{ artist_mbid: seed, name: 'Coast', turned_down: false }]
				}
			});
		if (path === 'discover/tunings') {
			if (req.method() === 'GET') return route.fulfill({ json: { items: tunings } });
			expect(req.postDataJSON()).toEqual({ kind: 'less_from_seed', target: seed });
			tunings = [{ kind: 'less_from_seed', target: seed, name: 'Coast' }];
			return route.fulfill({ json: tunings[0] });
		}
		if (path === 'discover/tunings/less_from_seed/' + seed) {
			expect(req.method()).toBe('DELETE');
			tunings = [];
			return route.fulfill({ status: 204 });
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected DN request: ' + req.method() + ' ' + path);
	});
	await localSignIn(page, server);
	const button = (name: string) => page.getByRole('button', { name, exact: true });
	await button('Discover').click();
	await button('Browse Discover queue').click();
	const menu = button('Feedback for Mountain');
	await expect
		.poll(() => observed.filter((r) => r.event === 'shown' && r.release_group_mbid === first))
		.toHaveLength(1);
	await menu.click();
	await button('Preview album').click();
	const audio = page.getByLabel('Album sample');
	await expect(audio).toBeVisible();
	expect(observed.filter((r) => r.event === 'sampled')).toHaveLength(0);
	await audio.evaluate(async (node: HTMLAudioElement) => {
		node.muted = true;
		await node.play();
	});
	await expect
		.poll(() => observed.filter((r) => r.event === 'sampled' && r.release_group_mbid === first))
		.toHaveLength(1);
	await button('Not for me').click();
	await expect(page.getByRole('alert')).toHaveText('Permission denied');
	expect(feedback).toEqual([]);
	deny = false;
	await button('Why this pick?').click();
	await expect(page.getByText('Because you listen to Coast.')).toBeVisible();
	await button('Suggest less based on Coast').click();
	await expect(button('Reduced recommendations from Coast')).toBeDisabled();
	for (const [label, kind] of [
		['Not now', 'not_now'],
		['Know it already', 'know_it'],
		['Not for me', 'no'],
		['Not this artist', 'not_artist']
	]) {
		await button(label).click();
		await expect(menu).toHaveCount(0);
		expect(feedback[0].kind).toBe(kind);
		if (kind === 'not_artist') await expect(button('Feedback for Valley')).toHaveCount(0);
		await button('Discover feedback').click();
		await button(kind === 'not_artist' ? 'Undo Cloud' : 'Undo Mountain').click();
		await button('Show recommendations').click();
		await menu.click();
	}
	await button('Close').click();
	await button('Discover feedback').click();
	await button('Undo Coast').click();
	await expect(page.getByText('No Discover feedback yet.')).toBeVisible();
	expect(tunings).toEqual([]);
	// Another client writes feedback while this list is still open.
	feedback = [
		{
			kind: 'no',
			target: 'album',
			target_mbid: second,
			artist_name: 'Cloud',
			release_name: 'Valley'
		}
	];
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await button('Undo Valley').click();
	expect(feedback).toEqual([]);
	await button('Show recommendations').click();
	await expect(button('Feedback for Valley')).toBeVisible();
	await page
		.locator('[data-collection="expanded"]:visible [data-part="album-card"]')
		.first()
		.click();
	await expect
		.poll(() => observed.filter((r) => r.event === 'opened' && r.release_group_mbid === first))
		.toHaveLength(1);
	expect(
		observed.filter((r) => r.event === 'shown' && r.release_group_mbid === first)
	).toHaveLength(1);
});
