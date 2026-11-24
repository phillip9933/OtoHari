import { chooseOption, choiceList } from './fixtures/inlineChoice';
import { verticalSwipe } from './fixtures/verticalSwipe';
import { touchRange } from './fixtures/touchRange';
import { emptyBoardRead } from './fixtures/emptyBoardRead';
import { expect, test, type Page } from '@playwright/test';
import type { components } from '../../frontend/src/lib/api/v3/openapi';
type S = components['schemas'];
const server = 'https://requests.example/music',
	api = server + '/api/v3';
const id = 'a39044ac-1fa7-4e7c-a616-58632eb221bb';
const second = 'ff683f78-3087-4dfa-8708-37c981bedbca';
const third = '4a1e4149-6ccb-43dc-ba92-6a3e176c36a3';
function row(
	mbid: string,
	name: string,
	status: S['RequestStatus'],
	kind: S['RequestKind'] = 'album'
): S['RequestItem'] {
	return {
		musicbrainz_id: mbid,
		artist_name: 'North',
		album_title: name,
		requested_at: 1,
		status,
		request_kind: kind,
		origin: 'user',
		requester_count: 0,
		user_id: 'owner'
	};
}
function task(taskId: string, title: string, status: S['TaskStatus']): S['DownloadTaskResponse'] {
	return {
		id: taskId,
		user_id: 'owner',
		download_type: 'album',
		source: 'soulseek',
		origin: 'user',
		release_group_mbid: id,
		artist_name: 'North',
		album_title: title,
		status,
		progress_percent: 0,
		downloaded_bytes: 0,
		files_total: 2,
		files_completed: 0,
		files_failed: 0,
		retry_count: 0,
		created_at: 1,
		updated_at: 1,
		retry_max: 0,
		retry_ladder_minutes: [],
		acquisition_cleanup_state: 'not_tracked',
		remote_queued: false,
		attempt_number: 1,
		attempt_total: 2,
		has_next_source: false,
		held_for_review: false
	};
}
async function connect(page: Page, role: S['Role']) {
	const calls: string[] = [];
	let active = [
		{ ...row(id, 'Shared train', 'downloading', 'track'), user_id: 'other', requester_count: 1 },
		row(third, 'Warehouse', 'queued')
	];
	let history = [row(second, 'Missed train', 'failed', 'track')];
	let approvals = [
		row(id, 'Junction', 'awaiting_approval', 'track'),
		row(second, 'Crossing', 'awaiting_approval')
	];
	const tasks: S['DownloadTaskResponse'][] = [
		{
			...task('stalled', 'Stalled transfer', 'downloading'),
			candidate_index: 0,
			progress_percent: 37,
			files_completed: 1,
			remote_queued: true,
			has_next_source: true
		},
		task('finished', 'Finished transfer', 'completed'),
		{
			...task('failed', 'Failed transfer', 'partial'),
			user_id: 'other',
			search_job_id: 'job',
			candidate_index: 1,
			source: 'usenet'
		},
		...['choose', 'watch', 'stop', 'other'].map((name) => ({
			...task(name, 'Matches ' + name, 'queued'),
			user_id: name === 'other' ? 'another-listener' : 'owner',
			search_job_id: name
		})),
		{ ...task('held', 'Held recording', 'partial'), held_for_review: true },
		task('manual', 'Look again', 'failed'),
		{ ...task('scheduled', 'Later transfer', 'failed'), retry_max: 2, next_retry_at: 1799999999 }
	];
	await page.route(api + '/**', async (route) => {
		const req = route.request(),
			url = new URL(req.url()),
			path = url.pathname.replace('/music/api/v3', ''),
			m = req.method();
		const json = (data: unknown) => route.fulfill({ json: data });
		if (path === '/auth/providers')
			return json({ local: true, oidc: false, jellyfin: false, plex: false });
		if (path === '/auth/login') return json({ token: 'fixture' });
		expect(req.headers().authorization).toBe('Bearer fixture');
		calls.push(m + ' ' + path + url.search);
		if (path === '/me') return json({ id: 'owner', display_name: 'Listener', role });
		if (path === '/me/section-prefs') return json({ pages: { home: [], discover: [] } });
		if (path === '/home') return json({ sections: [] });
		if (path === '/library/albums') return json({ items: [], total: 0 });
		if (path === '/held') return json({ entries: [] });
		if (path === '/requests/active') return json({ items: active });
		if (path === '/requests/history') {
			const filter = url.searchParams.get('status');
			const items = filter ? history.filter((r) => r.status === filter) : history;
			return json({ items, total: items.length, page: 1, total_pages: 1 });
		}
		if (path === '/requests/approvals/batches')
			return route.fulfill({ status: 404, json: { message: 'Route not found' } });
		if (path === '/requests/approvals') {
			expect(role).toBe('admin');
			return json({ items: approvals });
		}
		if (path === '/downloads/tasks')
			return json({ items: tasks, page: 1, page_size: 30 } satisfies S['DownloadListResponse']);
		if (path === '/downloads/search/album') {
			expect(m).toBe('POST');
			expect(req.postDataJSON()).toMatchObject({
				release_group_mbid: id,
				artist_name: 'North',
				album_title: 'Look again'
			});
			return json({ status: 'searching', job_id: 'manual' } satisfies S['SearchAlbumResponse']);
		}
		const search = path.match(
			/^\/downloads\/search\/(choose|watch|stop|manual)(?:\/(pick|dismiss|cancel))?$/
		);
		if (search) {
			const [, job, action] = search;
			if (!action) {
				expect(m).toBe('GET');
				return json({
					job_id: job,
					artist_name: 'North',
					album_title: 'Matches ' + job,
					release_group_mbid: id,
					status: 'completed',
					candidate_count: 2,
					candidates: [
						{
							candidate_index: 0,
							title: 'Alternate edition',
							note: { code: 'names_album', text: 'The release title matches.' },
							source: 'usenet',
							file_count: 0,
							size_bytes: 0,
							tier: 'possible',
							files: []
						},
						{
							candidate_index: 1,
							title: 'Night edition',
							note: { code: 'complete', text: 'Tracklist matches.' },
							username: 'fixture peer',
							source: 'soulseek',
							format: 'FLAC',
							file_count: 2,
							size_bytes: 1048576,
							tier: 'refused',
							files: [{ filename: 'folder/disc-1.flac', extension: 'flac', size: 1048576 }],
							refusal: ['over_size_cap']
						}
					]
				} satisfies S['SearchJobResponse']);
			}
			expect(m).toBe('POST');
			expect([
				['choose', 'pick'],
				['watch', 'dismiss'],
				['stop', 'cancel']
			]).toContainEqual([job, action]);
			if (action === 'pick')
				expect(req.postDataJSON()).toEqual({ candidate_index: 1, confirm_policy_break: true });
			const entry = tasks.find((t) => t.id === job)!;
			entry.status = action === 'pick' ? 'downloading' : 'cancelled';
			return json(action === 'pick' ? { task_id: 'picked' } : { success: true, state: 'watching' });
		}
		if (path === '/requests/active/' + id) {
			expect(m).toBe('DELETE');
			expect(url.searchParams.get('kind')).toBe('track');
			active = active.filter((i) => i.musicbrainz_id !== id);
			return json({
				success: true,
				message: 'Removed from your requests. The shared request continues.'
			});
		}
		if (path === '/requests/active/' + third) {
			expect(m).toBe('DELETE');
			expect(url.searchParams.get('kind')).toBe('album');
			active = active.filter((item) => item.musicbrainz_id !== third);
			return json({ success: false, message: 'Request changed while cancelling.' });
		}
		if (path === '/requests/retry/' + second) {
			expect(m).toBe('POST');
			expect(url.searchParams.get('kind')).toBe('track');
			history = [];
			return json({ success: true, message: 'Retry awaiting approval.' });
		}
		if (
			path === '/requests/approvals/' + id + '/approve' ||
			path === '/requests/approvals/' + second + '/reject'
		) {
			expect(role).toBe('admin');
			expect(m).toBe('POST');
			const approved = path.endsWith('/approve');
			expect(url.searchParams.get('kind')).toBe(approved ? 'track' : 'album');
			approvals = approvals.filter((r) => r.musicbrainz_id !== (approved ? id : second));
			return json({ success: true, message: approved ? 'Request approved.' : 'Request rejected.' });
		}
		if (path === '/downloads/tasks/stalled/next-source') {
			expect(m).toBe('POST');
			expect(req.postDataJSON()).toEqual({ expected_candidate_index: 0 });
			tasks[0].remote_queued = false;
			return json({ success: true, status: 'downloading', candidate_index: 1 });
		}
		if (path === '/downloads/tasks/failed/reimport') {
			expect(role).toBe('admin');
			expect(m).toBe('POST');
			tasks[2].status = 'completed';
			return json({ success: true, status: 'completed' });
		}
		if (await emptyBoardRead(route)) return;
		throw new Error('Unexpected request ' + m + ' ' + path);
	});
	await page.goto('/');
	await page.getByLabel('Server address').fill(server);
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	await page.getByLabel('Username').fill('owner');
	await page.getByLabel('Password', { exact: true }).fill('fixture');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page
		.getByRole('navigation', { name: 'Music' })
		.getByRole('button', { name: 'Requests', exact: true })
		.click();
	return calls;
}

test('a listener can withdraw a shared track, retry history, and manage their own download', async ({
	page
}) => {
	const calls = await connect(page, 'user'),
		modal = page.getByRole('dialog');
	await expect(page.getByRole('tab', { name: 'Approvals', exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions for Shared train' }).click();
	await expect(modal).toContainText('Other listeners keep theirs.');
	await modal.getByRole('button', { name: 'Go back' }).click();
	expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(0);
	await page.getByRole('button', { name: 'Actions for Shared train' }).click();
	await modal.getByRole('button', { name: 'Withdraw request' }).click();
	await expect(page.getByRole('button', { name: 'Actions for Shared train' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions for Warehouse' }).click();
	await modal.getByRole('button', { name: 'Cancel request' }).click();
	await expect(page.getByRole('alert')).toHaveText('Request changed while cancelling.');
	await expect(page.getByRole('button', { name: 'Actions for Warehouse' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions for Missed train' }).click();
	await modal.getByRole('button', { name: 'Retry request' }).click();
	await expect(page.getByText('Retry awaiting approval.')).toBeVisible();
	await page.getByRole('tab', { name: 'Downloads', exact: true }).click();
	await expect(page.getByText('Finished transfer')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Actions for Finished transfer' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Actions for Failed transfer' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Actions for Stalled transfer' }).click();
	await modal.getByRole('button', { name: 'Try next source' }).click();
	await modal.getByRole('button', { name: 'Try next source' }).click();
	await expect(page.getByText('DN switched to the next source.')).toBeVisible();
	expect(calls.some((c) => c.includes('/requests/approvals'))).toBe(false);
});

test('an admin reviews pending track and album requests and retries a failed import', async ({
	page
}) => {
	await connect(page, 'admin');
	const modal = page.getByRole('dialog');
	await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
	for (const [title, action] of [
		['Junction', 'Approve request'],
		['Crossing', 'Reject request']
	]) {
		await page.getByRole('button', { name: 'Actions for ' + title }).click();
		await modal.getByRole('button', { name: action }).click();
		await modal.getByRole('button', { name: action }).click();
		await expect(page.getByRole('button', { name: 'Actions for ' + title })).toHaveCount(0);
	}
	await expect(page.getByText('No requests awaiting approval.')).toBeVisible();
	await page.getByRole('tab', { name: 'Downloads', exact: true }).click();
	await page.getByRole('button', { name: 'Actions for Failed transfer' }).click();
	await modal.getByRole('button', { name: 'Retry import' }).click();
	await modal.getByRole('button', { name: 'Retry import' }).click();
	await expect(page.getByText('DN retried the import.')).toBeVisible();
});

test('a listener reviews matches, confirms a settings override, watches or cancels other searches, and opens held files on their own DN', async ({
	page
}) => {
	const calls = await connect(page, 'user');
	await page.getByRole('tab', { name: 'Downloads', exact: true }).click();
	const modal = page.getByRole('dialog');
	await page.getByRole('button', { name: 'Actions for Look again' }).click();
	await modal.getByRole('button', { name: 'Search manually' }).click();
	await modal.getByRole('button', { name: 'Search manually' }).click();
	await expect(modal.getByRole('button', { name: /Night edition/ })).toBeVisible();
	await modal.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByRole('button', { name: 'Actions for Look again' }).click();
	await modal.getByRole('button', { name: 'Review manual search' }).click();
	await modal.getByRole('button', { name: 'Review manual search' }).click();
	await expect(modal.getByRole('button', { name: /Night edition/ })).toBeVisible();
	await modal.getByRole('button', { name: 'Close', exact: true }).click();
	expect(calls.filter((c) => c === 'POST /downloads/search/album')).toHaveLength(1);
	await page.getByRole('button', { name: 'Review matches for Matches choose' }).click();
	await modal.getByRole('button', { name: /Night edition/ }).click();
	await expect(modal.getByText('Exceeds your size limit')).toBeVisible();
	await modal.getByText('View files (1)').click();
	await expect(modal.getByText('disc-1.flac')).toBeVisible();
	expect(calls.some((c) => c.endsWith('/pick'))).toBe(false);
	await modal.getByRole('button', { name: 'Download anyway' }).click();
	await expect(page.getByText('Download started from your selection.')).toBeVisible();
	expect(calls.filter((c) => c.endsWith('/pick'))).toHaveLength(1);
	for (const [job, pick, confirm, receipt] of [
		[
			'watch',
			'None of these, keep watching',
			'Keep watching',
			'DN will keep watching for this album.'
		],
		['stop', 'Stop search', 'Stop search', 'Search stopped.']
	]) {
		await page.getByRole('button', { name: 'Review matches for Matches ' + job }).click();
		await modal.getByRole('button', { name: pick, exact: true }).click();
		await modal.getByRole('button', { name: confirm, exact: true }).click();
		await expect(page.getByText(receipt)).toBeVisible();
	}
	await expect(page.getByRole('button', { name: 'Review matches for Matches other' })).toHaveCount(
		0
	);
	await page.getByText('More on your server').click();
	await expect(page.getByRole('link', { name: 'Manage wanted watches' })).toHaveAttribute(
		'href',
		server + '/requests?tab=wanted'
	);
	await expect(page.getByRole('link', { name: 'Inspect quarantined downloads' })).toHaveCount(0);
	const held = page.getByRole('button', { name: 'Review held files for Held recording' });
	await held.click();
	await expect(page.getByRole('dialog').getByText('No held files to review.')).toBeVisible();
	await page.getByRole('button', { name: 'Back', exact: true }).click();
	expect(calls).toContain('GET /held?task_id=held');
});

test('administrators see links to the deployed upgrade, import, auto-download and quarantine pages', async ({
	page
}) => {
	await connect(page, 'admin');
	await page.getByRole('tab', { name: 'Downloads', exact: true }).click();
	await page.getByText('More on your server').click();
	const pages = {
		'Import files into the library': '/downloads?tab=import',
		'Review quality upgrades': '/requests?tab=upgrades',
		'Manage auto-downloads': '/requests?tab=auto-download',
		'Inspect quarantined downloads': '/downloads'
	};
	for (const [label, path] of Object.entries(pages)) {
		await expect(page.getByRole('link', { name: label })).toHaveAttribute('href', server + path);
	}
	await expect(page.getByRole('button', { name: 'Review matches for Matches other' })).toHaveCount(
		0
	);
});

test('request tabs, history filters and transfer groups expose their state', async ({ page }) => {
	const calls = await connect(page, 'user');
	const tabs = page.getByRole('tablist', { name: 'Request views' });
	const current = tabs.getByRole('tab', { name: 'Activity', selected: true });
	await expect(current).toBeVisible();
	const history = page.getByRole('region', { name: 'Request history' });
	await history.getByText('Filter and sort history').click();
	await chooseOption(history.getByLabel('History status'), 'imported');
	await expect(history.getByText('No requests match this status.')).toBeVisible();
	await chooseOption(history.getByLabel('History order'), 'oldest');
	await expect.poll(() => calls.some((c) => c.includes('status=imported&sort=oldest'))).toBe(true);
	await chooseOption(history.getByLabel('History status'), 'failed');
	await expect(history.getByText('Missed train')).toBeVisible();
	await choiceList(history.getByLabel('History status'));
	await expect(history.getByRole('option', { name: 'Can reimport' })).toHaveCount(0);
	await current.focus();
	await page.keyboard.press('ArrowRight');
	await expect(tabs.getByRole('tab', { name: 'Downloads', selected: true })).toBeFocused();
	const panel = page.getByRole('tabpanel', { name: 'Downloads' });
	await expect(
		panel.getByRole('region', { name: 'Needs review' }).getByText('Held recording')
	).toBeVisible();
	const moving = panel.getByRole('region', { name: 'In progress' });
	await expect(
		moving.getByRole('progressbar', { name: 'Download progress for Stalled transfer' })
	).toHaveAttribute('value', '37');
	await expect(moving.getByText('1 of 2 files')).toBeVisible();
	await expect(
		panel.getByRole('region', { name: 'Scheduled retries' }).getByText('Later transfer')
	).toBeVisible();
	await expect(
		panel.getByRole('region', { name: 'Download history' }).getByText('Finished transfer')
	).toBeVisible();
	await page.keyboard.press('Home');
	await expect(tabs.getByRole('tab', { name: 'Activity', selected: true })).toBeFocused();
});

for (const theme of ['dark', 'light', 'midnight']) {
	test('request text and statuses remain legible in ' + theme, async ({ page }, testInfo) => {
		await page.addInitScript(
			(mode) => localStorage.setItem('dn.mobile.appearance.mode.v2', mode),
			theme
		);
		await connect(page, 'admin');
		await page.getByRole('tab', { name: 'Downloads' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
		const badges = page.locator('[data-part="download-task"] [data-tone]');
		await expect(badges.first()).toBeVisible();
		const ratios = await badges.evaluateAll((elements) => {
			// Canvas resolves both sRGB and the web themes’ OKLCH colors to sRGB.
			const ctx = document.createElement('canvas').getContext('2d')!;
			function luminance(color: string) {
				ctx.fillStyle = color;
				ctx.fillRect(0, 0, 1, 1);
				const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data).map((v) => {
					const s = v / 255;
					return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
				});
				return 0.2126 * r + 0.7152 * g + 0.0722 * b;
			}
			return elements.map((el) => {
				const st = getComputedStyle(el),
					ink = luminance(st.color),
					bg = luminance(st.backgroundColor);
				return (Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05);
			});
		});
		expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390
		);
		await page.screenshot({ path: testInfo.outputPath('downloads-' + theme + '.png') });
	});
}

test('an admin can read transfer progress and reach every request action with large text on a narrow phone', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 740 });
	await connect(page, 'admin');
	await page.addStyleTag({ content: 'html { font-size: 200% }' });
	const views = page.getByRole('tablist', { name: 'Request views' });
	for (const name of ['Activity', 'Downloads', 'Approvals']) {
		const tab = views.getByRole('tab', { name, exact: true });
		await tab.click();
		const panel = page.getByRole('tabpanel', { name });
		await expect(panel.getByRole('list').first()).toBeVisible();
		const overflowing = await page.evaluate(() => {
			const elements = document.querySelectorAll<HTMLElement>(
				'[role="tab"], [role="tabpanel"] button, button[aria-label^="Refresh"], progress + span, nav[aria-label="Music"] button'
			);
			return Array.from(elements)
				.filter((element) => element.checkVisibility() && element.getBoundingClientRect().width)
				.filter((element) => {
					const bounds = element.getBoundingClientRect();
					return (
						bounds.left < -1 ||
						bounds.right > document.documentElement.clientWidth + 1 ||
						element.scrollWidth > element.clientWidth + 1
					);
				})
				.map((element) => element.getAttribute('aria-label') || element.textContent?.trim());
		});
		expect(overflowing).toEqual([]);
	}
});

test('held files use only the chosen eligible file IDs and keep replacement and discard behind confirmation', async ({
	page
}) => {
	await connect(page, 'trusted');
	const writes: { path: string; body: unknown }[] = [];
	const heldFile = (id: number, name: string, actions: S['HeldFileAction'][], taskId = 'held') =>
		({
			id,
			original_name: name,
			track_title: name,
			source_task_id: taskId,
			source: 'soulseek',
			reason: 'wrong_track',
			reason_kind: 'hold',
			reason_text: 'This recording differs.',
			reason_action: 'Review the file.',
			actions,
			created_at: 18,
			recording_mbid: second
		}) satisfies S['HeldFileResponse'];
	let files = [
		heldFile(8, 'Mixed.flac', ['import', 'recheck']),
		heldFile(9, 'Existing.flac', ['use_this_file']),
		heldFile(10, 'Other task.flac', ['import'], 'elsewhere')
	];
	await page.route(api + '/held**', async (route) => {
		const req = route.request(),
			url = new URL(req.url());
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (req.method() === 'GET') {
			expect(url.searchParams.get('task_id')).toBe('held');
			expect(url.searchParams.has('all')).toBe(false);
			return route.fulfill({
				json: {
					entries: [
						{
							id: 3,
							album_title: 'Held recording',
							origin: 'download',
							state: 'held',
							created_at: 18,
							files
						} satisfies S['HeldEntryResponse']
					]
				}
			});
		}
		const body = req.postDataJSON();
		writes.push({ path: url.pathname, body });
		files = files.filter((f) => !body.file_ids.includes(f.id));
		return route.fulfill({ json: { imported: 1, discarded: 0, already_owned: 0, still_held: 0 } });
	});
	await page.route(api + '/search/albums?**', async (route) => {
		expect(new URL(route.request().url()).searchParams.get('q')).toBe('Held recording');
		await route.fulfill({
			json: {
				results: [
					{ title: 'Reissue', artist: 'North', musicbrainz_id: second },
					{ title: 'Unidentified local row' }
				]
			}
		});
	});
	await page.getByRole('tab', { name: 'Downloads' }).click();
	await page.getByRole('button', { name: 'Review held files for Held recording' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByText('Other task.flac')).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Use this file (1)' }).click();
	await expect(dialog.getByText(/recycle bin/)).toBeVisible();
	await expect(dialog.getByText('Mixed.flac', { exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	expect(writes).toEqual([]);
	await dialog.getByRole('button', { name: 'Discard (2)' }).click();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('dn-back', { cancelable: true })));
	await dialog.getByRole('checkbox', { name: 'Existing.flac' }).uncheck();
	await dialog.getByRole('button', { name: 'Match to album (1)' }).click();
	await dialog.getByRole('button', { name: /Reissue/ }).click();
	await expect(dialog.getByText('Import the selected files as Reissue by North.')).toBeVisible();
	expect(writes).toEqual([]);
	await dialog.getByRole('button', { name: 'Confirm match to album' }).click();
	await expect(dialog.getByText('1 imported.')).toBeVisible();
	expect(writes).toEqual([
		{ path: '/music/api/v3/held/3/match', body: { file_ids: [8], release_group_mbid: second } }
	]);
	await expect(dialog.getByRole('checkbox', { name: 'Mixed.flac' })).toHaveCount(0);
});

test('live downloads and queued matches remain visible above newer history across queue pages', async ({
	page
}) => {
	await connect(page, 'user');
	const history = Array.from({ length: 32 }, (_, i) =>
		task('old' + i, 'Past transfer ' + i, 'completed')
	);
	const waiting = Array.from({ length: 100 }, (_, i) => ({
		...task('q' + i, 'Queued ' + i, 'queued'),
		search_job_id: 'job' + i,
		candidate_index: 0
	}));
	const review = { ...task('review', 'Old match', 'queued'), search_job_id: 'review' };
	const moving = task('down', 'Old download', 'downloading');
	const process = task('process', 'Old import', 'processing');
	await page.route(api + '/downloads/tasks?**', (route) => {
		const params = new URL(route.request().url()).searchParams,
			status = params.get('status'),
			page = Number(params.get('page')),
			size = Number(params.get('page_size'));
		const data =
			status === 'queued'
				? [...waiting, review]
				: status === 'downloading'
					? [moving]
					: status === 'processing'
						? [process]
						: history;
		return route.fulfill({
			json: { items: data.slice((page - 1) * size, page * size), page, page_size: size }
		});
	});
	await page.getByRole('tab', { name: 'Downloads' }).click();
	const panel = page.getByRole('tabpanel', { name: 'Downloads' });
	await expect(panel.getByRole('button', { name: 'Review matches for Old match' })).toBeVisible();
	const headings = panel.getByRole('heading', { level: 2 });
	expect(await headings.allTextContents()).toEqual([
		'Needs review 1',
		'In progress 2',
		'Queued 100',
		'Download history 30'
	]);
	await panel.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(panel.getByText('History page 2')).toBeVisible();
	await expect(panel.getByText('Old download')).toBeVisible();
	await expect(panel.getByText('Old import')).toBeVisible();
	await expect(panel.getByText('Past transfer 30', { exact: true })).toBeVisible();
});

test('held review uses viewer scope and refreshes after a stale discard without replaying the deletion', async ({
	page
}) => {
	await connect(page, 'admin');
	let reads = 0,
		writes = 0;
	await page.route(api + '/held**', (route) => {
		const req = route.request(),
			url = new URL(req.url());
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (req.method() === 'GET') {
			reads++;
			expect(url.searchParams.get('all')).toBe('true');
			expect(url.searchParams.has('task_id')).toBe(false);
			return route.fulfill({
				json: {
					entries: writes
						? []
						: [
								{
									id: 7,
									state: 'held',
									origin: 'import_folder',
									album_title: 'Loose tracks',
									created_at: 1,
									files: [
										{
											id: 5,
											original_name: 'loose.flac',
											reason: 'wrong_track',
											reason_kind: 'hold',
											reason_text: 'No verified match.',
											reason_action: 'Pick an album.',
											actions: [],
											source: 'import_folder',
											created_at: 1
										}
									]
								}
							]
				}
			});
		}
		expect(url.pathname).toBe('/music/api/v3/held/7/discard');
		expect(req.postDataJSON()).toEqual({ file_ids: [5] });
		writes++;
		return route.fulfill({
			status: 409,
			json: { message: 'Another listener handled these files.' }
		});
	});
	await page.getByRole('tab', { name: 'Downloads' }).click();
	await page.getByRole('button', { name: 'Review all held files' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('button', { name: /Loose tracks/ }).click();
	await expect(dialog.getByRole('button', { name: /^Import/ })).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Discard (1)' }).click();
	await expect(dialog.getByText(/Permanently delete these original files/)).toBeVisible();
	expect(writes).toBe(0);
	await dialog.getByRole('button', { name: 'Confirm discard' }).click();
	await expect(dialog.getByRole('alert')).toBeVisible();
	expect(writes).toBe(1);
	expect(reads).toBe(2);
	await expect(dialog.getByRole('button', { name: 'Confirm discard' })).toHaveCount(0);
});

test('a listener auditions their own held file from DN and rechecks eligible fingerprints', async ({
	page
}) => {
	await connect(page, 'user');
	const recording = Buffer.alloc(44 + 8000);
	recording.write('RIFF');
	recording.writeUInt32LE(recording.length - 8, 4);
	recording.write('WAVEfmt ', 8);
	recording.writeUInt32LE(16, 16);
	recording.writeUInt16LE(1, 20);
	recording.writeUInt16LE(1, 22);
	recording.writeUInt32LE(8000, 24);
	recording.writeUInt32LE(8000, 28);
	recording.writeUInt16LE(1, 32);
	recording.writeUInt16LE(8, 34);
	recording.write('data', 36);
	recording.writeUInt32LE(8000, 40);
	let previewReads = 0,
		checks = 0;
	await page.route(api + '/held**', async (route) => {
		const req = route.request(),
			url = new URL(req.url());
		expect(req.headers().authorization).toBe('Bearer fixture');
		if (url.pathname.endsWith('/audio')) {
			previewReads++;
			expect(req.headers().range).toBe('bytes=0-2097151');
			return route.fulfill({
				status: 206,
				headers: {
					'Content-Type': 'audio/wav',
					'Content-Range': 'bytes 0-' + (recording.length - 1) + '/' + recording.length,
					'Content-Length': String(recording.length)
				},
				body: recording
			});
		}
		if (req.method() === 'POST') {
			expect(url.pathname).toBe('/music/api/v3/held/recheck');
			expect(req.postDataJSON()).toEqual({ entry_ids: [7] });
			checks++;
			return route.fulfill({
				json: { results: [{ entry_id: 7, file_id: 5, status: 'still_held' }] }
			});
		}
		expect(url.searchParams.has('all')).toBe(false);
		return route.fulfill({
			json: {
				entries: [
					{
						id: 7,
						state: 'held',
						origin: 'upload',
						created_at: 1,
						album_title: 'Uncertain',
						files: [
							{
								id: 5,
								original_name: 'Open.wav',
								reason_text: 'The recording could not be confirmed.',
								reason_action: 'Listen to the file.',
								actions: ['recheck']
							}
						]
					}
				]
			}
		});
	});
	await page.getByRole('tab', { name: 'Downloads' }).click();
	await page.getByRole('button', { name: 'Review all held files' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByRole('button', { name: /Uncertain/ }).click();
	await expect(
		dialog.getByRole('button', {
			name: /Match to album|Check album edition|Use this file|Import \(/
		})
	).toHaveCount(0);
	expect(previewReads).toBe(0);
	await dialog.getByRole('button', { name: 'Preview Open.wav' }).click();
	await expect(dialog.locator('audio')).toHaveJSProperty('paused', false);
	expect(previewReads).toBe(1);
	await page.keyboard.press('Escape');
	await dialog.getByRole('button', { name: 'Recheck held fingerprints' }).click();
	expect(checks).toBe(0);
	await dialog.getByRole('button', { name: 'Confirm recheck' }).click();
	await expect(dialog.getByText('1 still held.')).toBeVisible();
	expect(checks).toBe(1);
});

test('pulling a review sheet returns one step, preserves inner scrolling and never submits a match', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 360 });
	const calls = await connect(page, 'user');
	await page.getByRole('tab', { name: 'Downloads', exact: true }).click();
	await page.getByRole('button', { name: 'Review matches for Matches choose' }).click();
	const modal = page.getByRole('dialog');
	const option = modal.getByRole('button', { name: /Night edition/ });
	await option.click();
	const body = modal.locator('.body');
	await expect(modal.getByRole('button', { name: 'Download anyway' })).toBeVisible();
	await body.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
	const rect = (await body.boundingBox())!;
	await verticalSwipe(page, rect.x + rect.width / 2, rect.y + 32, 85);
	await expect(modal.getByRole('button', { name: 'Download anyway' })).toBeVisible();
	await body.evaluate((el) => {
		el.scrollTop = 0;
	});
	// Inspect a confirmation halfway, then change your mind without navigating back or submitting it.
	const heading = modal.locator('h2');
	const top = () => modal.evaluate((el) => el.getBoundingClientRect().top);
	const origin = await top();
	const touch = await touchRange(page);
	try {
		const { x, y } = await touch.point(heading);
		await touch.hold(heading);
		await touch.moveTo(x, y + 92);
		await expect.poll(top).toBeGreaterThan(origin + 65);
		await touch.moveTo(x, y + 18);
		await expect.poll(top).toBeLessThan(origin + 32);
		await touch.cancel();
		await expect.poll(top).toBeCloseTo(origin, 0);
		await expect(modal.getByRole('button', { name: 'Download anyway' })).toBeVisible();
		expect(calls.filter((c) => c.endsWith('/pick'))).toHaveLength(0);
	} finally {
		await touch.close();
	}
	await verticalSwipe(page, rect.x + rect.width / 2, rect.y + 32, 85);
	await expect(option).toBeVisible();
	const header = (await modal.locator('h2').boundingBox())!;
	await verticalSwipe(page, header.x + header.width / 2, header.y + header.height / 2, 75);
	await expect(modal).toBeHidden();
	expect(calls.filter((c) => c.endsWith('/pick'))).toHaveLength(0);
});

test('playlist approval cards count one decision and confirm the exact albums to approve and reject', async ({
	page
}) => {
	await connect(page, 'admin');
	const items = [
		{ musicbrainz_id: id, title: 'River', artist_name: 'North' },
		{ musicbrainz_id: second, title: 'Coast', artist_name: 'East' }
	];
	let waiting = true;
	const submissions: unknown[] = [];
	await page.route(api + '/requests/approvals/batches**', async (route) => {
		expect(route.request().headers().authorization).toBe('Bearer fixture');
		if (route.request().method() === 'GET')
			return route.fulfill({
				json: {
					cards: waiting
						? [{ id: 'batch', name: 'Open roads', requester_name: 'Listener', items }]
						: []
				}
			});
		expect(route.request().method()).toBe('POST');
		expect(new URL(route.request().url()).pathname).toContain('/batches/batch/decide');
		submissions.push(route.request().postDataJSON());
		waiting = false;
		return route.fulfill({ json: { approved: 1, rejected: 1, skipped: 0 } });
	});
	await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Awaiting approval 3' })).toBeVisible();
	const batch = page.getByRole('region', { name: 'Playlist request · Open roads' });
	await batch.getByRole('button', { name: /Open roads/ }).click();
	await batch.getByRole('checkbox', { name: /Coast/ }).uncheck();
	await batch.getByRole('button', { name: 'Approve 1' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('Approve 1 and reject 1');
	await dialog.getByRole('button', { name: 'Go back' }).click();
	expect(submissions).toEqual([]);
	await batch.getByRole('button', { name: 'Approve 1' }).click();
	await dialog.getByRole('button', { name: 'Approve selection' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Approved 1, rejected 1.' })
	).toBeVisible();
	expect(submissions).toEqual([{ approve: [id] }]);
	await expect(page.getByRole('heading', { name: 'Awaiting approval 2' })).toBeVisible();
});

test('a failed grouped approval read leaves individual requests usable and never claims the queue is empty', async ({
	page
}) => {
	await connect(page, 'admin');
	await page.route(api + '/requests/approvals/batches', (route) =>
		route.fulfill({ status: 503, json: { message: 'Try later' } })
	);
	await page.getByRole('tab', { name: 'Approvals', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('Playlist approvals could not be refreshed');
	await expect(page.getByRole('button', { name: 'Actions for Junction' })).toBeVisible();
	await expect(page.getByText('No requests awaiting approval.')).toHaveCount(0);
});
