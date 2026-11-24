import { emptyAccountTheme, emptyTrackRating } from './fixtures/emptyBoardRead';
import { minimizePlayer } from './fixtures/minimizePlayer';
import { chooseOption } from './fixtures/inlineChoice';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { components } from '../../frontend/src/lib/api/v3/openapi';
type Schema = components['schemas'];
const server = 'https://dn.example/music';
const artist = 'b53fc3e3-49d1-42dd-a9cf-a64a7cb019e6';
const group = '19cf82e5-32dc-4827-8a4c-59b8f895dcde';
const artistName = 'Crescent Trio';

test('a listener explores DN charts and genres, follows an artist and plays library songs and radio', async ({
	page
}) => {
	let following = false,
		hidden = false;
	let concertCities: Schema['EventCity'][] = [];
	const reads: string[] = [];
	await page.addInitScript(
		({ server }) => {
			localStorage.setItem(
				'dn.mobile.layout.v1.' + JSON.stringify([server, 'user', 'home']),
				JSON.stringify([{ id: 'discover-radio_sections', preview: true }])
			);
			const ids = [
				'top_picks',
				'weekly_exploration',
				'missing_essentials',
				'popular_albums',
				'your_top_albums',
				'trending_artists',
				'following',
				'releases',
				'concerts',
				'genre_list',
				'discover_queue',
				'playlist_discovery',
				'radio_sections'
			];
			localStorage.setItem(
				'dn.mobile.layout.v1.' + JSON.stringify([server, 'user', 'discover']),
				JSON.stringify(ids.map((key, i) => ({ id: 'discover-' + key, title: '', preview: i < 3 })))
			);
		},
		{ server }
	);
	await page.route(server + '/api/v3/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url());
		const path = url.pathname.slice('/music/api/v3'.length);
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers')
			return json({ local: true, oidc: false, plex: false, jellyfin: false });
		if (path === '/auth/login') return json({ token: 'listener-session' });
		expect(req.headers().authorization).toBe('Bearer listener-session');
		if (path === '/me') return json({ id: 'user', display_name: 'Listener' });
		if (path === '/library/albums') return json({ items: [], next: null, total: 0 });
		if (path.includes('artwork') || path.startsWith('/covers/'))
			return route.fulfill({ status: 404 });
		reads.push(path);
		if (path === '/me/section-prefs')
			return json({
				pages: {
					discover: [
						{
							key: 'missing_essentials',
							available: true,
							enabled: false,
							turned_off: false,
							title: 'Missing essentials',
							zone: 'from_your_library',
							description: ''
						}
					]
				}
			} satisfies Schema['SectionPrefsResponse']);
		if (path === '/library/tracks') {
			if (url.searchParams.get('q') === 'Silver Moon') {
				if (!url.searchParams.get('after'))
					return json({
						items: [
							{
								id: 'wrong-edition',
								recording_mbid: 'another-recording',
								artist_name: artistName,
								album_title: 'Crescent',
								title: 'Silver Moon'
							}
						],
						next: 'second',
						total: 2
					});
				return json({
					items: [
						{
							id: 'local-one',
							recording_mbid: group,
							artist_name: artistName,
							album_title: 'Crescent',
							title: 'Silver Moon',
							duration_seconds: 1
						}
					],
					total: 2
				});
			}
			const title = url.searchParams.get('q');
			if (title === 'Blue Hour' || title === 'Silver Skies') {
				const id = title === 'Blue Hour' ? 'local-blue' : 'radio-one';
				return json({
					items: [{ id, title, artist_name: artistName, album_title: 'Moonrise' }],
					total: 1
				});
			}
			expect(title).toBe('Golden Hour');
			return json({ items: [], total: 0 });
		}

		if (path === '/discover/queue')
			return json({
				queue_id: 'first',
				items: [
					{
						artist_id: artist,
						artist_name: artistName,
						in_library: false,
						is_wildcard: false,
						musicbrainz_id: group,
						title: 'Nightfall',
						recommendation_reason: 'From your recent listening'
					}
				]
			} satisfies Schema['DiscoverQueueResponse']);
		if (path === '/discover/picks/events') return route.fulfill({ status: 404 });
		if (path === '/discover/feedback' && req.method() === 'GET')
			return route.fulfill({ status: 404 });
		if (path === '/discover/queue/ignore') {
			expect(req.postDataJSON().release_group_mbid).toBe(group);
			hidden = true;
			return route.fulfill({ status: 204 });
		}
		if (path === '/discover/queue/ignored')
			return json({
				items: hidden
					? [
							{
								release_group_mbid: group,
								release_name: 'Nightfall',
								artist_mbid: artist,
								artist_name: artistName,
								ignored_at: 3
							}
						]
					: []
			} satisfies Schema['IgnoredReleasesResponse']);
		if (path === '/discover/queue/ignored/' + group) {
			expect(req.method()).toBe('DELETE');
			hidden = false;
			return route.fulfill({ status: 204 });
		}
		if (path === '/playlists')
			return json({ playlists: [{ id: 'one', name: 'Late evening', is_owner: true }] });
		if (path === '/discover/playlist-suggestions') {
			expect(req.postDataJSON().playlist_id).toBe('one');
			return json({
				playlist_id: 'one',
				suggestions: {
					type: 'albums',
					title: 'For this playlist',
					items: [
						{
							kind: 'album',
							musicbrainz_id: group,
							title: 'Late moon',
							artist_name: artistName,
							in_library: false,
							requested: false
						}
					]
				},
				profile: {}
			});
		}
		if (path === '/home')
			return json({
				sections: [
					{
						key: 'genre_list',
						zone: 'browse_genres',
						content: {
							shape: 'shelf',
							shelf: {
								title: 'Genres',
								type: 'genres',
								items: [{ kind: 'genre', name: 'Art pop' }]
							}
						}
					}
				],
				service_prompts: [],
				genre_artwork: {},
				genre_artwork_schema_version: '1',
				refreshing: false
			} satisfies Schema['HomeResponse']);
		if (path === '/home/genre/Art%20pop')
			return json({
				genre: 'Art pop',
				genre_artwork: { kind: 'gradient', version: '1', albums: [] },
				library: {
					albums: [
						{
							musicbrainz_id: group,
							title: 'Moonrise',
							artist_name: artistName,
							in_library: true,
							requested: false
						}
					],
					artists: [{ musicbrainz_id: artist, name: artistName, in_library: true }],
					album_count: 1,
					artist_count: 1
				},
				popular: null
			} satisfies Schema['GenreDetailResponse']);
		if (path === '/artists/' + artist + '/top-songs')
			return json({
				source: 'lastfm',
				asked_source: 'lastfm',
				configured: true,
				needs_account: [],
				unavailable_sources: [],
				songs: [
					{
						title: 'Blue Hour',
						artist_name: artistName,
						release_group_mbid: group,
						track_number: 1,
						release_name: 'Moonrise'
					},
					{ title: 'Lost Song', artist_name: artistName }
				]
			} satisfies Schema['TopSongsResponse']);
		if (path === '/library/resolve-tracks') {
			expect(req.postDataJSON().items).toEqual([
				{ release_group_mbid: group, disc_number: 1, track_number: 1 }
			]);
			return json({
				items: [
					{
						release_group_mbid: group,
						disc_number: 1,
						track_number: 1,
						source: 'local',
						track_source_id: 'local-blue',
						duration: 0.3
					}
				]
			} satisfies Schema['ResolveTracksResponse']);
		}
		if (path === '/discover/radio/plan') {
			const body = req.postDataJSON() as Schema['RadioPlanRequest'];
			expect(req.method()).toBe('POST');
			expect(body.mode).toBe('library');
			const owned = {
				track_name: 'Silver Skies',
				artist_name: artistName,
				artist_mbid: artist,
				album_name: 'Moonrise',
				in_library: true,
				local_file_id: 'radio-one'
			};
			const unavailable = {
				...owned,
				track_name: 'Remote-only radio entry',
				in_library: false,
				local_file_id: 'foreign-file'
			};
			if (body.seed_type === 'artist') {
				expect(body.seed_id).toBe(artist);
				return json({
					title: 'Artist station',
					tracks: [
						unavailable,
						{ ...owned, track_name: 'Missing file ID', local_file_id: null },
						owned
					]
				} satisfies Schema['RadioPlanResponse']);
			}
			expect(body.seed_type).toBe('genre');
			expect(body.seed_id).toBe('Art pop');
			return json({
				title: 'Genre station',
				tracks: [unavailable]
			} satisfies Schema['RadioPlanResponse']);
		}
		if (
			['/stream/local/radio-one', '/stream/local/local-one', '/stream/local/local-blue'].includes(
				path
			)
		)
			return route.fulfill({
				path: fileURLToPath(
					new URL('../../server/tests/fixtures/library/management_full.wav', import.meta.url)
				),
				contentType: 'audio/wav'
			});
		if (path === '/artists/' + artist + '/top-albums')
			return json({
				source: 'lastfm',
				asked_source: 'lastfm',
				configured: true,
				needs_account: [],
				unavailable_sources: [],
				albums: [
					{
						title: 'Moonrise',
						musicbrainz_id: group,
						artist_name: artistName,
						in_library: true,
						requested: false
					}
				]
			} satisfies Schema['TopAlbumsResponse']);
		if (path === '/discover')
			return json({
				discover_queue_enabled: true,
				service_prompts: [],
				genre_artwork: {},
				genre_artwork_schema_version: '1',
				refreshing: false,
				sections: [
					{
						key: 'genre_list',
						zone: 'browse_genres',
						content: {
							shape: 'shelf',
							shelf: {
								type: 'genres',
								items: [{ kind: 'genre', name: 'Art pop' }],
								title: 'Browse genres'
							}
						}
					},
					{
						key: 'radio_sections',
						zone: 'essentials',
						content: {
							shape: 'shelves',
							shelves: [
								{
									title: 'Radio: Crescent Trio',
									type: 'albums',
									radio_seed_type: 'artist',
									radio_seed_id: artist,
									items: [
										{
											kind: 'album',
											musicbrainz_id: group,
											title: 'Station album',
											artist_name: artistName,
											in_library: true,
											requested: false
										}
									]
								},
								{
									title: 'Radio: Blue',
									type: 'tracks',
									items: [{ kind: 'track', title: 'Station track', artist_name: artistName }]
								}
							]
						}
					},
					{
						key: 'weekly_exploration',
						zone: 'essentials',
						content: {
							shape: 'weekly',
							weekly: {
								playlist_date: '2026-11-21',
								source_url: '',
								title: 'Weekly exploration',
								tracks: [
									{ album_name: 'Crescent', artist_name: artistName, title: 'Golden Hour' },
									{
										album_name: 'Crescent',
										artist_name: artistName,
										title: 'Silver Moon',
										recording_mbid: group
									}
								]
							}
						}
					},
					{
						key: 'top_picks',
						zone: 'essentials',
						content: {
							shape: 'picks',
							picks: {
								title: 'Top picks',
								personalizing: false,
								items: [
									{
										album: {
											musicbrainz_id: group,
											title: 'Moonrise',
											artist_name: artistName,
											requested: false,
											in_library: false
										},
										match_pct: 92,
										reasons: []
									}
								]
							}
						}
					}
				]
			} satisfies Schema['DiscoverResponse']);
		if (path === '/home/popular/albums' || path === '/home/your-top/albums') {
			expect(url.searchParams.get('range')).toBe('this_month');
			const personal = path.includes('your-top');
			return json({
				items: [
					{
						musicbrainz_id: group,
						title: personal ? 'On repeat' : 'Crowd favourite',
						artist_name: artistName,
						in_library: personal,
						requested: false
					}
				],
				range_key: 'this_month',
				label: 'Albums',
				limit: 24,
				offset: 0,
				has_more: false
			} satisfies Schema['ChartPage_AlbumRef']);
		}
		if (path === '/home/trending/artists')
			return json({
				items: [{ name: artistName, musicbrainz_id: artist, in_library: false }],
				range_key: 'this_month',
				label: 'Trending',
				limit: 24,
				offset: 0,
				has_more: false
			} satisfies Schema['ChartPage_ArtistRef']);
		if (path === '/artists/' + artist + '/follow') {
			expect(req.method()).toBe('PUT');
			expect(req.postDataJSON()).toEqual({ followed: !following });
			following = !following;
		}
		if (path.startsWith('/artists/' + artist + '/follow'))
			return json({
				artist_mbid: artist,
				followed: following,
				auto_download: false,
				auto_download_state: 'none'
			} satisfies Schema['FollowStatusResponse']);
		if (path === '/artists/' + artist + '/releases')
			return json({
				albums: [{ id: group, title: 'Moonrise', in_library: false, requested: false }],
				eps: [],
				singles: [],
				offset: 0,
				limit: 24,
				has_more: false,
				returned_count: 1,
				warming: false,
				source: 'musicbrainz',
				service_status: null
			} satisfies Schema['ArtistReleases']);
		if (path === '/following/artists')
			return json({
				artists: following
					? [
							{
								artist_mbid: artist,
								name: artistName,
								followed_at: 1,
								auto_download: false,
								auto_download_state: 'none'
							}
						]
					: []
			} satisfies Schema['FollowedArtistListResponse']);
		if (path === '/following/new-releases/seen' || path === '/following/concerts/seen') {
			expect(req.method()).toBe('POST');
			return json({ count: 0 });
		}
		if (path === '/following/concerts/cities') {
			if (req.method() === 'PUT') concertCities = req.postDataJSON().items;
			return json({ items: concertCities });
		}
		if (path === '/following/concerts/city-search') {
			expect(url.searchParams.get('q')).toBe('Osaka');
			return json({
				items: [
					{ name: 'Osaka', latitude: 34.69, longitude: 135.5, country_code: 'JP', country: 'Japan' }
				]
			});
		}
		if (path === '/following/new-releases/recent')
			return json({
				items: [
					{
						artist_mbid: artist,
						artist_name: artistName,
						release_group_mbid: group,
						title: 'Moonrise',
						in_library: false
					}
				],
				total: 1
			} satisfies Schema['NewReleaseListResponse']);
		if (path === '/following/concerts')
			return json({
				configured: true,
				items: [
					{
						artist_mbid: artist,
						artist_name: artistName,
						source: 'ticketmaster',
						source_event_id: 'one',
						event_name: 'Evening concert',
						matched_city: 'Tokyo',
						local_date: '2027-03-04',
						venue_name: 'Civic Hall',
						status: 'scheduled'
					}
				],
				total: 1
			} satisfies Schema['ConcertsResponse']);
		if (path === '/library/albums/match/' + group)
			return route.fulfill({
				status: 404,
				json: { error: { code: 'NOT_FOUND', message: 'Missing' } }
			});
		if (path === '/albums/' + group + '/editions') return json({ items: [] });
		if ((await emptyTrackRating(route)) || (await emptyAccountTheme(route))) return;
		throw new Error('Unexpected DroppedNeedle request ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username', { exact: true }).fill('listener');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	const station = page.getByRole('button', { name: 'Crescent Trio', exact: true });
	await expect(station).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByText('Station album')).toHaveCount(0);
	await station.click();
	await expect(page.getByRole('heading', { name: 'Albums', exact: true })).toBeVisible();
	await expect(page.getByText('Station album')).toBeVisible();
	await page.getByRole('button', { name: 'Blue', exact: true }).click();
	await expect(page.getByText('Station album')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Play Station track' })).toBeVisible();
	await page.getByRole('button', { name: 'Browse Radio stations' }).click();
	await station.click();
	await expect(page.getByRole('button', { name: 'Play station', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Discover', exact: true }).click({ timeout: 4000 });
	await expect(page.getByRole('button', { name: 'Moonrise ' + artistName })).toBeVisible();
	await page.getByRole('button', { name: 'Play Golden Hour' }).click();
	await expect(page.getByText('Golden Hour is unavailable in your library.')).toBeVisible();
	await expect(page.locator('[data-widget="discover-missing_essentials"]')).toHaveCount(0);
	expect(reads.filter((p) => p === '/discover')).toHaveLength(1);
	await page.getByRole('button', { name: 'Play Silver Moon', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Silver Moon', exact: true })).toBeVisible();
	await minimizePlayer(page);
	const backToBoard = page.getByRole('button', { name: 'Back to Discover', exact: true });
	async function view(label: string) {
		if (await backToBoard.isVisible()) await backToBoard.click();
		await page.getByRole('button', { name: 'Browse ' + label, exact: true }).click();
	}
	await view('Discover queue');
	await expect(page.getByText('From your recent listening')).toBeVisible();
	await page.getByRole('button', { name: 'Feedback for Nightfall' }).click();
	await expect(page.getByRole('button', { name: 'Not now', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Hide album' }).click();
	await page.getByRole('button', { name: 'Discover feedback' }).click();
	await page.getByRole('button', { name: 'Undo Nightfall' }).click();
	await expect(page.getByText('No Discover feedback yet.')).toBeVisible();
	await view('Discover for a playlist');
	await chooseOption(page.getByLabel('Choose a playlist'), 'one');
	await expect(page.getByRole('button', { name: 'Late moon ' + artistName })).toBeVisible();
	await view('Popular albums');
	await expect(page.getByRole('button', { name: 'Crowd favourite ' + artistName })).toBeVisible();
	await view('Your top albums');
	await expect(page.getByRole('button', { name: 'On repeat ' + artistName })).toBeVisible();
	await view('Trending artists');
	await page.getByRole('button', { name: artistName, exact: true }).click();
	await page.getByRole('button', { name: 'Follow artist', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Unfollow artist', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Moonrise ' + artistName }).click();
	await expect(page.getByRole('heading', { name: 'Moonrise', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Unfollow artist', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Trending artists', exact: true })).toBeVisible();
	await view('Followed artists');
	await expect(page.getByRole('button', { name: artistName, exact: true })).toBeVisible();
	expect(reads).not.toContain('/following/new-releases/seen');
	await view('New releases from followed artists');
	await expect.poll(() => reads.includes('/following/new-releases/seen')).toBe(true);
	await expect(page.getByRole('button', { name: 'Moonrise ' + artistName })).toBeVisible();
	await view('Upcoming concerts');
	await expect.poll(() => reads.includes('/following/concerts/seen')).toBe(true);
	await page.getByText('Concert cities', { exact: true }).click();
	await page.getByRole('searchbox', { name: 'Find a city' }).fill('Osaka');
	// Preserve an unrelated city added on the web since this screen opened.
	concertCities.push({
		city_name: 'Tokyo',
		latitude: 35.7,
		longitude: 139.7,
		country_code: 'JP',
		radius_km: 32
	});
	await page.getByRole('button', { name: 'Osaka, Japan' }).click();
	await expect(page.getByRole('button', { name: 'Remove city Osaka' })).toBeVisible();
	expect(concertCities.map((c) => c.city_name)).toEqual(['Tokyo', 'Osaka']);
	await chooseOption(page.getByRole('combobox', { name: 'Concert radius for Osaka' }), '80');
	await expect.poll(() => concertCities[1]?.radius_km).toBe(80);
	await page.getByRole('button', { name: 'Remove city Osaka' }).click();
	await expect.poll(() => concertCities.map((c) => c.city_name)).toEqual(['Tokyo']);

	await expect(page.getByText('Civic Hall', { exact: false })).toBeVisible();
	await page.getByRole('button', { name: artistName, exact: true }).click();
	await page.getByRole('button', { name: 'Unfollow artist' }).click();
	await expect(page.getByRole('button', { name: 'Follow artist', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	await view('Followed artists');
	await expect(page.getByText('Artists you follow will appear here.')).toBeVisible();
	await view('Genres');
	await page.getByRole('button', { name: 'Art pop', exact: true }).click();
	await page.getByRole('button', { name: 'Play station' }).click();
	await expect(page.getByText('No playable library tracks for this station.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Moonrise ' + artistName })).toBeVisible();
	await page.getByRole('button', { name: artistName, exact: true }).click();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('dn-back', { cancelable: true })));
	await expect(page.getByRole('heading', { name: 'Art pop', exact: true })).toBeVisible();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('dn-back', { cancelable: true })));
	await page.getByRole('button', { name: 'Art pop', exact: true }).click();
	await page.getByRole('button', { name: artistName, exact: true }).click();
	const artistView = page.getByRole('combobox', { name: 'Artist view' });
	await chooseOption(artistView, 'albums');
	await expect(page.getByRole('button', { name: 'Moonrise ' + artistName })).toBeVisible();
	await chooseOption(artistView, 'songs');
	await expect(
		page.getByRole('button', { name: 'Lost Song, unavailable in your library' })
	).toBeDisabled();
	await page.getByRole('button', { name: 'Play Blue Hour', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Blue Hour', exact: true })).toBeVisible();
	await minimizePlayer(page);
	await page.getByRole('button', { name: 'Play artist radio' }).click();
	await expect(page.getByRole('heading', { name: 'Silver Skies', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Show play queue' }).click();
	const queue = page.locator('[data-part="play-queue"]');
	await expect(queue.getByRole('button')).toHaveCount(1);
	await expect(queue.getByRole('button', { name: /Silver Skies/ })).toBeVisible();
});
