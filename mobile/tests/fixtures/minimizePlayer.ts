import { expect, type Page } from '@playwright/test';

export async function minimizePlayer(page: Page) {
	const player = page.getByRole('region', { name: 'Now playing', exact: true });
	await expect(player).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(player).toBeHidden();
}
