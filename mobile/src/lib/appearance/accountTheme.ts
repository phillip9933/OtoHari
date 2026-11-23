import { writable } from 'svelte/store';
import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { accountId } from '../boards/layout';
import { getJson, putJson, type Session } from '../connection';
import { tr } from '../i18n';
import {
	applyTheme,
	hasDeviceTheme,
	isMode,
	readTheme,
	restoreTheme,
	savedCustom,
	type Theme,
	type Mode,
	type Selection
} from './theme';

type Appearance = components['schemas']['MyAppearance'];
const endpoint = '/api/v3/me/appearance';
type AccountTheme = {
	session: Session;
	follow: boolean;
	selection: Selection;
	custom?: Theme | null;
	appearance?: Appearance;
	error: string;
	saving: boolean;
};
const store = writable<AccountTheme | null>(null);
export const accountTheme = { subscribe: store.subscribe };
let current: AccountTheme | null = null;
let key = '';
let revision = 0;
function publish(value: AccountTheme | null) {
	current = value;
	store.set(value);
}
function present(error: unknown) {
	return error instanceof Error
		? error.message
		: tr('Could not load the account theme.', 'アカウントテーマを読み込めませんでした。');
}
function modeOf(appearance: Appearance): Mode {
	if (appearance.theme == null) return 'dark';
	if (isMode(appearance.theme)) return appearance.theme;
	throw Error(
		tr('This account uses an unsupported theme.', 'このアカウントのテーマには対応していません。')
	);
}

function rememberDeviceTheme(selection: Selection) {
	if (selection.mode === 'custom')
		localStorage.setItem(key + '.custom', JSON.stringify(selection.theme));
	localStorage.setItem(key + '.device', JSON.stringify(selection));
	localStorage.setItem(key, 'device');
}

function readDeviceTheme(fallback: Selection): Selection {
	const json = localStorage.getItem(key + '.device');
	if (!json) return fallback;
	const value = JSON.parse(json);
	if (isMode(value?.mode)) return { mode: value.mode };
	if (value?.mode === 'custom')
		return { mode: 'custom', theme: readTheme(JSON.stringify(value.theme)) };
	return fallback;
}

export async function refreshAccountTheme() {
	const account = current;
	if (!account || !key || account.saving) return;
	const call = ++revision;
	try {
		const appearance = await getJson<Appearance>(account.session, endpoint);
		const mode = modeOf(appearance);
		if (revision !== call || !current) return;
		if (current.follow) applyTheme({ mode });
		publish({
			...current,
			appearance,
			selection: current.follow ? { mode } : current.selection,
			error: ''
		});
		try {
			localStorage.setItem(key + '.last', mode);
		} catch {
			/* Use the live theme. */
		}
	} catch (e) {
		if (revision === call && current) publish({ ...current, error: present(e) });
	}
}

export function watchAccountTheme(session: Session | null) {
	key = '';
	const device = restoreTheme();
	applyTheme(device);
	const epoch = ++revision;
	publish(session ? { session, follow: true, selection: device, error: '', saving: false } : null);
	if (!session) return;
	void accountId(session)
		.then((owner) => {
			if (epoch !== revision || !current) return;
			key = 'dn.mobile.account-theme.' + JSON.stringify([session.serverUrl, owner]);
			let follow = true;
			let custom = savedCustom();
			let selection: Selection = { mode: 'dark' };
			try {
				const pref = localStorage.getItem(key);
				// Existing explicit choices predate account following. Keep them on this device.
				follow = pref ? pref === 'account' : !hasDeviceTheme();
				const cached = localStorage.getItem(key + '.last');
				selection = follow ? { mode: isMode(cached) ? cached : 'dark' } : readDeviceTheme(device);
				const storedCustom = localStorage.getItem(key + '.custom');
				if (storedCustom) custom = readTheme(storedCustom);
			} catch {
				/* Fall back to the account default. */
			}
			publish({ ...current, follow, selection, custom });
			applyTheme(selection);
			void refreshAccountTheme();
		})
		.catch((e) => {
			if (current?.session === session) publish({ ...current, error: present(e) });
		});
	const refresh = () => {
		if (document.visibilityState !== 'hidden' && navigator.onLine) void refreshAccountTheme();
	};
	window.addEventListener('online', refresh);
	document.addEventListener('visibilitychange', refresh);
	return () => {
		revision++;
		key = '';
		publish(null);
		window.removeEventListener('online', refresh);
		document.removeEventListener('visibilitychange', refresh);
	};
}

export function setAccountThemeFollow(follow: boolean) {
	if (!current || !key || current.saving) return;
	const selection =
		follow && current.appearance ? { mode: modeOf(current.appearance) } : current.selection;
	if (follow) localStorage.setItem(key, 'account');
	else rememberDeviceTheme(selection);
	applyTheme(selection);
	publish({ ...current, follow, selection, error: '' });
	if (follow) void refreshAccountTheme();
}

export async function chooseAccountTheme(selection: Selection, saveToAccount = false) {
	const account = current;
	if (!account || !key || account.saving) return;
	if (selection.mode === 'custom' || (!saveToAccount && !account.follow)) {
		rememberDeviceTheme(selection);
		applyTheme(selection);
		publish({
			...account,
			follow: false,
			selection,
			custom: selection.mode === 'custom' ? selection.theme : account.custom
		});
		return;
	}
	const call = ++revision;
	publish({ ...account, saving: true, error: '' });
	try {
		const appearance = await putJson<Appearance>(account.session, endpoint, {
			theme: selection.mode
		});
		const mode = modeOf(appearance);
		if (revision !== call || !current) return;
		applyTheme({ mode });
		publish({ ...current, appearance, selection: { mode }, error: '', saving: false });
		try {
			localStorage.setItem(key + '.last', mode);
		} catch {
			/* Use the live theme. */
		}
	} catch (e) {
		if (revision === call && current) publish({ ...current, saving: false, error: present(e) });
	}
}
