import { get, writable } from 'svelte/store';
import { tick } from 'svelte';
import type { Session } from '../connection';
import {
	House,
	LibraryBig,
	Compass,
	Search,
	ListChecks,
	Download,
	Menu,
	ListMusic,
	UsersRound,
	Disc3,
	Music2,
	Tags
} from '@lucide/svelte';

export const libraryDestinations = [
	{ id: 'playlists', label: 'Playlists', icon: ListMusic },
	{ id: 'artists', label: 'Artists', icon: UsersRound },
	{ id: 'albums', label: 'Albums', icon: Disc3 },
	{ id: 'tracks', label: 'Tracks', icon: Music2 },
	{ id: 'genres', label: 'Genres', icon: Tags }
] as const;
export const shortcuts = [
	{ id: 'home', label: 'Home', icon: House },
	{ id: 'library', label: 'Library', icon: LibraryBig },
	{ id: 'search', label: 'Search', icon: Search },
	{ id: 'discover', label: 'Discover', icon: Compass },
	{ id: 'requests', label: 'Requests', icon: ListChecks }
] as const;
export const destinations = [
	...shortcuts,
	...libraryDestinations,
	{ id: 'offline', label: 'Offline music', icon: Download },
	{ id: 'settings', label: 'Settings', icon: Menu }
] as const;
export type Destination = (typeof destinations)[number]['id'];
export type BrowseDestination = (typeof shortcuts)[number]['id'] | 'offline';
export type StartScreen = 'automatic' | 'home' | 'library' | 'player';
function accountKey(session: Session, name: 'start-screen' | 'mini-player') {
	return 'dn.mobile.' + name + '.v1.' + JSON.stringify([session.serverUrl, session.userId]);
}
export function readStartScreen(session: Session): StartScreen {
	try {
		const saved = session.userId && localStorage.getItem(accountKey(session, 'start-screen'));
		return saved === 'home' || saved === 'library' || saved === 'player' ? saved : 'automatic';
	} catch {
		return 'automatic';
	}
}
export function saveStartScreen(session: Session, screen: StartScreen) {
	if (!session.userId) return;
	const key = accountKey(session, 'start-screen');
	if (screen === 'automatic') localStorage.removeItem(key);
	else localStorage.setItem(key, screen);
}
export const miniButtons = {
	none: 'None',
	previous: 'Previous track',
	next: 'Next track',
	queue: 'Queue'
} as const;
export const miniText = {
	artist: 'Artist',
	album: 'Album',
	'artist-album': 'Artist and album',
	hidden: 'Hidden'
} as const;
export type MiniButton = keyof typeof miniButtons;
export type MiniPlayerPreferences = {
	artwork: boolean;
	secondary: keyof typeof miniText;
	progress: boolean;
	before: MiniButton;
	after: MiniButton;
};
export const defaultMiniPlayer: MiniPlayerPreferences = {
	artwork: true,
	secondary: 'artist',
	progress: false,
	before: 'none',
	after: 'next'
};
export function readMiniPlayer(session: Session | null): MiniPlayerPreferences {
	if (!session?.userId) return defaultMiniPlayer;
	try {
		const value = JSON.parse(
			localStorage.getItem(accountKey(session, 'mini-player')) || 'null'
		) as Partial<MiniPlayerPreferences> | null;
		if (!value) return defaultMiniPlayer;
		const before =
			typeof value.before === 'string' && Object.hasOwn(miniButtons, value.before)
				? value.before
				: defaultMiniPlayer.before;
		const after =
			typeof value.after === 'string' && Object.hasOwn(miniButtons, value.after)
				? value.after
				: defaultMiniPlayer.after;
		return {
			artwork: value.artwork !== false,
			secondary:
				typeof value.secondary === 'string' && Object.hasOwn(miniText, value.secondary)
					? value.secondary
					: defaultMiniPlayer.secondary,
			progress: value.progress === true,
			before,
			after: before === after ? 'none' : after
		};
	} catch {
		return defaultMiniPlayer;
	}
}
export function saveMiniPlayer(session: Session, value: MiniPlayerPreferences) {
	if (session.userId)
		localStorage.setItem(accountKey(session, 'mini-player'), JSON.stringify(value));
}
export const maxTabs = 5;
export type InterfacePreferences = {
	surface: 'solid' | 'glass' | 'blur';
	blur: number;
	bar: 'docked' | 'floating';
	tabs: Destination[];
	motion: 'off' | 'quick' | 'gentle';
};
const key = 'dn.mobile.interface.v2';
const legacyKey = 'dn.mobile.interface.v1';
export const defaultInterface: InterfacePreferences = {
	surface: 'solid',
	blur: 14,
	bar: 'docked',
	tabs: ['home', 'library', 'search', 'discover', 'requests'],
	motion: 'quick'
};
function normalize(value: Partial<InterfacePreferences> | null): InterfacePreferences {
	const valid = (id: unknown): id is Destination => destinations.some((d) => d.id === id);
	return {
		surface: value?.surface === 'glass' || value?.surface === 'blur' ? value.surface : 'solid',
		blur:
			typeof value?.blur === 'number' && Number.isInteger(value.blur)
				? Math.min(24, Math.max(0, value.blur))
				: defaultInterface.blur,
		bar: value?.bar === 'floating' ? 'floating' : 'docked',
		tabs: Array.isArray(value?.tabs)
			? [...new Set(value.tabs.filter(valid))].slice(0, maxTabs)
			: [...defaultInterface.tabs],
		motion: value?.motion === 'off' || value?.motion === 'gentle' ? value.motion : 'quick'
	};
}
function restore() {
	try {
		const current = localStorage.getItem(key);
		if (current !== null) return normalize(JSON.parse(current));
		const previous = JSON.parse(localStorage.getItem(legacyKey) || 'null');
		// The earlier Glass style used the listener's adjustable backdrop blur.
		return normalize({ ...previous, surface: previous?.surface === 'glass' ? 'blur' : 'solid' });
	} catch {
		return normalize(null);
	}
}
export const interfacePreferences = writable(restore());
export function setInterface(changes: Partial<InterfacePreferences>) {
	const next = normalize({ ...get(interfacePreferences), ...changes });
	localStorage.setItem(key, JSON.stringify(next));
	interfacePreferences.set(next);
}
let animation: Animation | undefined;
let visit = 0;

export function motionDuration() {
	const motion = get(interfacePreferences).motion;
	if (document.hidden || motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches)
		return 0;
	return motion === 'gentle' ? 280 : 160;
}

export function applyInterface() {
	return interfacePreferences.subscribe((p) => {
		const root = document.documentElement;
		root.dataset.material = p.surface;
		root.dataset.navigation = p.bar;
		root.dataset.motion = p.motion;
		root.style.setProperty('--material-blur', p.blur + 'px');
	});
}

export function cancelScreenMotion() {
	visit++;
	animation?.cancel();
	animation = undefined;
}

export function revealScreen({
	content,
	restore,
	animate = true
}: {
	content?: HTMLElement;
	restore?: () => void;
	animate?: boolean;
}) {
	cancelScreenMotion();
	const id = visit;
	void tick().then(() => {
		if (id !== visit) return;
		restore?.();
		const ms = animate ? motionDuration() : 0;
		if (!ms) return;
		const target = content ?? document.querySelector('main');
		animation = target?.animate?.([{ opacity: 0.8 }, { opacity: 1 }], {
			duration: ms * 0.7,
			easing: 'ease-out'
		});
	});
}

export function changeScreen(update: () => void, animate = true) {
	update();
	revealScreen({ animate });
}
