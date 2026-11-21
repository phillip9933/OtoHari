import { playerWithoutFeedback } from './fixtures/playerWithoutFeedback';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { components } from '../../frontend/src/lib/api/v3/openapi';

type Schema = components['schemas'];
const audio = fileURLToPath(
	new URL('../../server/tests/fixtures/library/management_full.wav', import.meta.url)
);

test('personal history keeps repeated listens and only replays unique local recordings', async ({
	page
}) => {
	const server = 'https://music.example/dn';
	await playerWithoutFeedback(page, server, 'owner');
	const melody = 'f921927a-9dd9-453c-aa4c-431ae00dab84';
	const track = (title: string, listened_at: string, musicbrainz_id: string | null) => ({
		kind: 'track' as const,
		title,
		artist_name: 'Night Train',
		album_name: 'Return Trip',
		listened_at,
		musicbrainz_id
	});
	const shelf: Schema['ChartSection'] = {
		title: 'Recently Played',
		type: 'tracks',
		source: 'local',
		items: [
			track('Main line', '2026-03-21T09:18:00Z', melody),
			track('Main line', '2026-03-21T09:14:00Z', melody),
			track('No ID', '2026-03-21T09:12:00Z', null),
			track('Two copies', '2026-03-21T09:10:00Z', melody),
			track('Gone', '2026-03-21T09:05:00Z', melody)
		]
	};
	const played: string[] = [],
		lookups: string[] = [];
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url()),
			path = url.pathname.replace('/dn/api/v3', '');
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (path === '/me') return json({ id: 'owner', display_name: 'Owner' });
		if (path === '/library/albums') return json({ items: [], next: null, total: 0 });
		if (path === '/home')
			return json({
				refreshing: false,
				sections: [
					{
						key: 'friends_listening',
						content: {
							shape: 'shelf',
							shelf: {
								...shelf,
								source: 'listenbrainz',
								items: [track('Another listener', '2026-03-21T09:11:00Z', melody)]
							}
						}
					},
					{ key: 'recently_played', content: { shape: 'shelf', shelf } }
				]
			});
		if (path === '/library/tracks') {
			const title = url.searchParams.get('q') ?? '';
			lookups.push(title);
			const local = {
				id: 'local-copy',
				title,
				artist_name: 'Night Train',
				album_title: 'Return Trip',
				art_missing: true,
				recording_mbid: melody.toUpperCase()
			};
			const other = { ...local, id: 'other-recording', recording_mbid: 'different' };
			if (title === 'Main line' && !url.searchParams.has('after'))
				return json({ items: [other], next: 'second' });
			return json({
				items:
					title === 'Gone'
						? [other]
						: title === 'Two copies'
							? [local, { ...local, id: 'another-copy' }]
							: [local],
				next: null
			});
		}
		if (path.startsWith('/stream/local/')) {
			played.push(path);
			return route.fulfill({ path: audio, contentType: 'audio/wav' });
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected fixture request ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('owner');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.getByRole('button', { name: 'Browse Recently played' }).click();
	const history = page.locator('[data-part="recent-listens"]:visible');
	await expect(history.locator('strong')).toHaveText([
		'Main line',
		'Main line',
		'No ID',
		'Two copies',
		'Gone'
	]);
	await expect(history.locator('time')).toHaveCount(5);
	await expect(history.getByRole('button', { name: 'Replay No ID' })).toHaveCount(0);
	expect(lookups).toEqual([]);
	const first = history.getByRole('button', { name: 'Replay Main line' }).first();
	await first.hover();
	await page.mouse.down();
	const selection = page.getByRole('group', { name: 'Selection actions' });
	try {
		await expect(selection.getByText('1 selected')).toBeVisible();
	} finally {
		await page.mouse.up();
	}
	await history.getByRole('button', { name: 'Select Main line' }).nth(1).click();
	await history.getByRole('button', { name: 'Select Gone' }).click();
	await expect(selection.getByText('3 selected')).toBeVisible();
	await selection.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveText('Gone · Local copy unavailable');
	expect(played).toEqual([]);
	await page.keyboard.press('Escape');
	lookups.length = 0;
	await history.getByRole('button', { name: 'Replay Two copies' }).click();
	await expect(history.getByText('Multiple local copies')).toBeVisible();
	await history.getByRole('button', { name: 'Replay Gone' }).click();
	await expect(history.getByText('Local copy unavailable')).toBeVisible();
	expect(played).toEqual([]);
	await history.getByRole('button', { name: 'Replay Main line' }).nth(1).click();
	await expect.poll(() => played).toEqual(['/stream/local/local-copy']);
	expect(lookups).toEqual(['Two copies', 'Gone', 'Main line', 'Main line']);
});

for (const scenario of ['disabled', 'enabled', 'unsupported'] as const) {
	test('an omitted history shelf with ' + scenario + ' web settings', async ({ page }) => {
		const server = 'https://music.example/dn';
		await page.route(server + '/api/v3/**', async (route) => {
			const req = route.request();
			const path = new URL(req.url()).pathname.replace('/dn/api/v3', '');
			const json = (data: unknown) => route.fulfill({ json: data });
			if (path === '/auth/providers') return json({ local: true, oidc: false });
			if (path === '/auth/login') return json({ token: 'fixture' });
			expect(req.method()).toBe('GET');
			expect(req.headers().authorization).toBe('Bearer fixture');
			if (path === '/me') return json({ id: 'owner', display_name: 'Owner' });
			if (path === '/library/albums') return json({ items: [], next: null, total: 0 });
			if (path === '/home') return json({ refreshing: scenario === 'disabled', sections: [] });
			if (path === '/me/section-prefs') {
				if (scenario === 'unsupported') return route.fulfill({ status: 404, json: {} });
				return json({
					pages: { home: [{ key: 'recently_played', enabled: scenario === 'enabled' }] }
				});
			}
			if (await emptyBoardRead(route)) return;
			throw Error('Unexpected fixture request ' + path);
		});
		await page.goto('/');
		await page.getByLabel('Server address').fill(server);
		await page.getByRole('button', { name: 'Continue', exact: true }).click();
		await page.getByLabel('Username').fill('owner');
		await page.getByLabel('Password', { exact: true }).fill('fixture');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		const message =
			scenario === 'disabled'
				? 'To see your recent plays, enable Recently Played under Settings → Content preferences → Home.'
				: 'No recent plays available from DroppedNeedle.';
		await expect(page.getByText(message, { exact: true })).toBeVisible();
	});
}
