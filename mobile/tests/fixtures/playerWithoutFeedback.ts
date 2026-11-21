import type { Page } from '@playwright/test';
import { defaultGridLayout } from '../../src/lib/player/grid';

// Isolate the library reads made by the feature under test from optional player tiles.
export async function playerWithoutFeedback(page: Page, server: string, user: string) {
	const key = 'dn.mobile.layout.v1.' + JSON.stringify([server, user, 'player']);
	const sections = defaultGridLayout().filter(
		(tile) => tile.id !== 'player-favorite' && tile.id !== 'player-rating'
	);
	await page.addInitScript(
		({ key, sections }) => {
			localStorage.setItem(key, JSON.stringify({ version: 3, sections }));
		},
		{ key, sections }
	);
}
