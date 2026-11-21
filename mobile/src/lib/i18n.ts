import { Capacitor } from '@capacitor/core';
import { androidAppearance, type AndroidLanguage } from './appearance/nativeAppearance';
import { fromStore, writable } from 'svelte/store';
import { japaneseText } from './locales/japaneseText';
export { japaneseText } from './locales/japaneseText';

export type LanguageChoice = 'system' | 'en' | 'ja';
const key = 'dn.mobile.language.v1';
function savedLanguage(): LanguageChoice {
	try {
		const value = localStorage.getItem(key);
		if (value === 'en' || value === 'ja') return value;
	} catch {
		// Private browsing may make device preferences unavailable.
	}
	return 'system';
}
function deviceLanguage() {
	return navigator.language.toLowerCase().split('-')[0] === 'ja' ? 'ja' : 'en';
}

export const languageChoice = writable<LanguageChoice>(savedLanguage());
const active = writable<'en' | 'ja'>('en');
const language = fromStore(active);
const hasNativeLanguage = () =>
	Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('DNAppearance');
let revision = 0;
function apply(
	choice: LanguageChoice,
	effective = choice === 'system' ? deviceLanguage() : choice
) {
	languageChoice.set(choice);
	document.documentElement.lang = effective;
	active.set(effective);
}
function remember(choice: LanguageChoice) {
	try {
		if (choice === 'system') localStorage.removeItem(key);
		else localStorage.setItem(key, choice);
	} catch {
		// A restricted browser can still use the chosen language for this session.
	}
}
function useNative(state: AndroidLanguage) {
	if (
		!state ||
		!['en', 'ja', 'system'].includes(state.choice) ||
		!['en', 'ja'].includes(state.effective)
	)
		return;
	remember(state.choice);
	apply(state.choice, state.effective);
}
export function applyLanguage() {
	apply(savedLanguage());
	const sync = () => {
		if (!hasNativeLanguage()) {
			apply(savedLanguage());
			return;
		}
		const version = revision;
		void androidAppearance
			.getLanguage()
			.then((state) => {
				if (version === revision) useNative(state);
			})
			.catch(() => {});
	};
	sync();
	window.addEventListener('languagechange', sync);
	window.addEventListener('dn-language-change', sync);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) sync();
	});
}
export async function setLanguage(choice: LanguageChoice) {
	const version = ++revision;
	if (hasNativeLanguage()) {
		const state = await androidAppearance.setLanguage({ choice });
		if (version === revision) useNative(state);
	} else {
		remember(choice);
		apply(choice);
	}
}

export function tr(english: string, ja: string) {
	return language.current === 'ja' ? ja : english;
}
/** Translate app-owned labels only. Music metadata, user labels and DN responses keep their original text. */
export function uiText(english: string) {
	return language.current === 'ja' ? japaneseText(english) : english;
}

export function uiFormat(message: string, values: Record<string, string | number>) {
	return uiText(message).replace(/\{([a-z]+)\}/g, (token, name: string) =>
		Object.hasOwn(values, name) ? String(values[name]) : token
	);
}
