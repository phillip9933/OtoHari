import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const server = 'https://queue.example/dn';
const wav = fileURLToPath(
	new URL('../../server/tests/fixtures/library/management_full.wav', import.meta.url)
);

test('editing the queue keeps the current entry and repeat all wraps to the visible first track', async ({
	page
}) => {
	const played: string[] = [];
	const tracks = ['First', 'Second', 'Third'].map((title, i) => ({
		id: title,
		title,
		artist_name: 'Fixture artist',
		album_title: 'Queue album',
		album_id: 'q',
		track_number: i + 1,
		disc_number: 1,
		duration_seconds: 0.3,
		art_missing: true
	}));
	await page.route(server + '/api/v3/**', async (route) => {
		const path = new URL(route.request().url()).pathname.slice('/dn/api/v3'.length);
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/me/section-prefs') return json({ pages: { home: [], discover: [] } });
		if (path === '/home') return json({ sections: [] });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'queue-fixture' });
		expect(route.request().headers().authorization).toBe('Bearer queue-fixture');
		if (path === '/me') return json({ id: 'user', display_name: 'Listener', role: 'user' });
		if (path === '/library/albums')
			return json({
				items: [
					{ id: 'q', title: 'Queue album', artist_name: 'Fixture artist', art_missing: true }
				],
				next: null
			});
		if (path === '/library/albums/match/q') return json({ items: tracks, total: tracks.length });
		if (path.startsWith('/stream/local/')) {
			played.push(path.split('/').at(-1)!);
			return route.fulfill({ path: wav, contentType: 'audio/wav' });
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected request ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.getByRole('button', { name: /Queue album/ }).click();
	await page.getByRole('button', { name: 'Play album', exact: true }).click();
	await expect.poll(() => played).toEqual(['First', 'Second', 'Third']);
	await page.getByRole('button', { name: 'Show play queue' }).click();
	await page.getByRole('button', { name: 'Edit queue' }).click();
	const queue = page.locator('[data-part="play-queue"]');
	await queue.getByRole('button', { name: 'Reorder Third, position 3' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Move Third up' }).click();
	await expect(queue.locator('strong')).toHaveText(['First', 'Third', 'Second']);
	await expect(queue.locator('[aria-current="true"]')).toContainText('Third');
	await queue.getByRole('button', { name: 'Remove First from queue' }).click();
	await expect(queue.locator('strong')).toHaveText(['Third', 'Second']);
	await queue.getByRole('button', { name: 'Reorder Third, position 1' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Move Third down' }).click();
	await expect(queue.locator('[aria-current="true"]')).toContainText('Third');
	expect(played).toEqual(['First', 'Second', 'Third']);
	await page.getByRole('button', { name: 'Hide play queue' }).click();
	await page.getByRole('button', { name: /Repeat off/ }).click();
	await expect(page.getByRole('button', { name: /Repeat all/ })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await page
		.getByRole('region', { name: 'Now playing' })
		.getByRole('button', { name: 'Next track', exact: true })
		.click();
	await expect.poll(() => played[3]).toBe('Second');
});
