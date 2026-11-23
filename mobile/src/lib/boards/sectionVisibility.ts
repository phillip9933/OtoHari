import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { getJson, putJson, type Session } from '../connection';
import { forgetDiscoveryPage } from '../catalog/discoveryWidgets';
import { tr } from '../i18n';

type Schema = components['schemas'];
export type SectionPrefs = Schema['SectionPrefsResponse'];
export type SectionPage = Schema['SectionPage'];
export const visibilityEvent = 'dn-section-visibility';
const endpoint = '/api/v3/me/section-prefs';

// Only map the same section on the same page. A Discover shelf pinned to Home
// must never toggle the web Discover page as a side effect of editing Home.
const homeLibrary: Record<string, string> = {
	'library-recently-added': 'recently_added',
	'library-recently-played': 'recently_played',
	'library-albums': 'library_albums',
	'library-artists': 'library_artists'
};
export function sharedSection(rows: Schema['SectionPrefItem'][] | undefined, id: string) {
	const key = id.startsWith('discover-') ? id.slice('discover-'.length) : homeLibrary[id];
	return key ? rows?.find((row) => row.key === key) : undefined;
}
export function getVisibility(session: Session, signal?: AbortSignal) {
	return getJson<SectionPrefs>(session, endpoint, signal);
}
export async function saveVisibility(
	session: Session,
	page: SectionPage,
	changes: Record<string, boolean>
) {
	// PUT replaces one page. Re-read it to preserve other clients' intervening edits,
	// including unknown registry entries and service-gated preferences.
	const latest = await getVisibility(session);
	const current = latest.pages[page];
	if (
		!current ||
		Object.keys(changes).some((key) => !current.some((row) => row.key === key && row.available))
	)
		throw Error(
			tr(
				'Some sections changed on DroppedNeedle. Reopen this editor to review them.',
				'DroppedNeedleのセクションが変更されました。開き直して確認してください。'
			)
		);
	const saved = await putJson<SectionPrefs>(session, endpoint, {
		page,
		sections: current.map((row) => ({ key: row.key, enabled: changes[row.key] ?? row.enabled }))
	} satisfies Schema['SectionPrefsUpdate']);
	const merged = { pages: { ...latest.pages, ...saved.pages } };
	forgetDiscoveryPage(session);
	window.dispatchEvent(new CustomEvent(visibilityEvent, { detail: { session, prefs: merged } }));
	return merged;
}
