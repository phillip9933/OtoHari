import { test, expect } from '@playwright/test';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { localSignIn } from './fixtures/localSignIn';

test('paste resolves only a song address, reports provider status and saves a missing recording without requesting it', async ({
	page
}) => {
	const server = 'https://links.example';
	const id = '295083ee-ac70-11df-a3ca-0017f2992468';
	let link: string | null = 'read',
		status = 'ok';
	const queries: string[] = [],
		writes: unknown[] = [];
	const spotify = 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b';
	await page.addInitScript(
		(value) =>
			Object.defineProperty(navigator, 'clipboard', {
				value: { readText: async () => value },
				configurable: true
			}),
		'listen here ' + spotify + '?si=private'
	);
	await page.route(server + '/api/v3/**', async (route) => {
		const request = route.request(),
			url = new URL(request.url()),
			path = url.pathname.slice('/api/v3'.length);
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers') return json({ local: true, oidc: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		if (path === '/me') return json({ id: 'listener', role: 'user', display_name: 'Listener' });
		if (path === '/search') {
			queries.push(url.searchParams.get('q') ?? '');
			expect(url.searchParams.get('buckets')).toBe('tracks');
			return json({
				link,
				artist_status: 'ok',
				album_status: 'ok',
				track_status: status,
				artists: [],
				albums: [],
				tracks:
					link === 'read'
						? [
								{
									title: 'Signal',
									artist: 'Yuki',
									musicbrainz_id: id,
									art_missing: true,
									remote_track: {
										release_group_mbid: 'release',
										album_title: 'Lights',
										duration_seconds: 182
									}
								}
							]
						: []
			});
		}
		if (path === '/playlists')
			return json({
				playlists: [
					{ id: 'p', name: 'My playlist', is_redacted: false, can_edit: true, cover_urls: [] }
				]
			});
		if (path === '/playlists/p/tracks') {
			expect(request.method()).toBe('POST');
			writes.push(request.postDataJSON());
			return json({ tracks: [{ id: 'e' }] });
		}
		if (await emptyBoardRead(route)) return;
		throw Error('Unexpected song link fixture route ' + path);
	});
	await localSignIn(page, server);
	await page.getByRole('navigation').getByRole('button', { name: 'Search', exact: true }).click();
	await page
		.getByRole('group', { name: 'Search category' })
		.getByRole('button', { name: 'Genres' })
		.click();
	await page.getByRole('button', { name: 'Paste a song link' }).click();
	await page.getByRole('button', { name: 'Add to playlist · Signal' }).click();
	await page.getByRole('button', { name: 'Add track', exact: true }).click();
	await expect(page.getByText('Added 1 track to My playlist.')).toBeVisible();
	await page.getByRole('button', { name: 'Done' }).click();
	expect(writes).toEqual([
		{
			tracks: [
				{
					recording_mbid: id,
					album_id: 'release',
					track_name: 'Signal',
					artist_name: 'Yuki',
					album_name: 'Lights',
					duration: 182,
					source_type: '',
					track_source_id: null,
					available_sources: null,
					cover_url: '/api/v3/covers/release-group/release?size=500'
				}
			]
		}
	]);
	expect(queries).toEqual([spotify]);
	const input = page.getByRole('searchbox', { name: 'Search music' });
	for (const [index, outcome, message] of [
		[0, 'needs_spotify', 'Your DroppedNeedle admin needs to enable Spotify'],
		[1, 'unreadable', 'could not read this song link'],
		[2, 'no_match', 'No MusicBrainz recording matches'],
		[3, null, 'This server did not resolve the link']
	] as const) {
		link = outcome;
		await input.fill('https://www.deezer.com/track/' + index);
		await expect(page.getByText(message, { exact: false })).toBeVisible();
	}
	link = 'read';
	status = 'stale';
	await input.fill('https://music.apple.com/jp/album/music/12?i=34&at=tracking');
	await expect(page.getByText('MusicBrainz is unavailable. Showing cached matches.')).toBeVisible();
	expect(queries.at(-1)).toBe('https://music.apple.com/jp/album/music/12?i=34');
	await input.fill('https://music.apple.com.evil.example/private?secret=1');
	await expect(
		page.getByText('Use a song link from Spotify, Apple Music, Deezer, YouTube or song.link.')
	).toBeVisible();
	expect(queries).toHaveLength(6);
});
