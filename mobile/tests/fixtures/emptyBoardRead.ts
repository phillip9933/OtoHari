import type { Route } from '@playwright/test';

export async function emptyAccountTheme(route: Route) {
	if (
		route.request().method() !== 'GET' ||
		!new URL(route.request().url()).pathname.endsWith('/api/v3/me/appearance')
	)
		return false;
	await route.fulfill({ json: { theme: null, custom_css: null } });
	return true;
}

export async function emptyTrackRating(route: Route) {
	const req = route.request();
	if (req.method() !== 'POST' || !new URL(req.url()).pathname.endsWith('/api/v3/ratings/lookup'))
		return false;
	const body = req.postDataJSON();
	if (
		Object.keys(body).length !== 1 ||
		!Array.isArray(body.track_ids) ||
		body.track_ids.length !== 1 ||
		typeof body.track_ids[0] !== 'string'
	)
		return false;
	await route.fulfill({ json: { tracks: {}, albums: {}, artists: {} } });
	return true;
}

// Strict feature fixtures serve other visible shelves and player feedback after their own routes.
export async function emptyBoardRead(route: Route) {
	if ((await emptyTrackRating(route)) || (await emptyAccountTheme(route))) return true;
	const req = route.request();
	const path = new URL(req.url()).pathname.split('/api/v3/')[1];
	if (!path) return false;
	if (req.method() !== 'GET') return false;
	if (
		/^(library\/(artists|albums)\/[^/]+\/artwork|covers\/(artist|release-group)\/[^/]+)$/.test(path)
	) {
		await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
		return true;
	}
	switch (path) {
		case 'search/suggest':
			await route.fulfill({ json: { results: [], status: 'ok' } });
			return true;
		case 'discover':
		case 'home':
			await route.fulfill({ json: { sections: [], refreshing: false } });
			return true;
		case 'me/section-prefs':
			await route.fulfill({ json: { pages: { home: [], discover: [] } } });
			return true;
		case 'library/albums':
		case 'library/artists':
		case 'library/tracks':
			await route.fulfill({ json: { items: [], next: null, total: 0 } });
			return true;
		case 'playlists':
			await route.fulfill({ json: { playlists: [] } });
			return true;
		default:
			return false;
	}
}
