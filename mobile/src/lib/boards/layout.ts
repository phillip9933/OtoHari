import { uiText } from '../i18n';
import { isFilteredSection, libraryFilter, type FilterSection } from './filteredSections';
import { boardDisplay, type BoardDisplay } from './display';
import { getJson, type Session } from '../connection';
import { discoveryWidgets, defaultDiscoveryWidgets } from '../catalog/discoveryWidgets';
import { libraryWidgets } from '../catalog/libraryWidgets';
import {
	defaultGridLayout,
	isPlayerGrid,
	PLAYER_GRID_VERSION,
	upgradeV2GridRect,
	type GridRect
} from '../player/grid';
import { expandLegacyTrack, isPlayerSlot, isPlayerText } from '../player/composition';
import {
	playerMeasurements,
	validMeasurement,
	playerWidgets,
	playerFields,
	isNavigation,
	isPlayerIcon,
	playerOptions
} from '../player/layout';

export type Board = 'home' | 'library' | 'discover';
export type LayoutTarget = Board | 'player';
export type Section = {
	grid?: GridRect;
	iconMode?: 'fixed' | 'fill';
	id: string;
	title: string;
	preview: boolean;
	display?: BoardDisplay;
	filter?: FilterSection;
	minHeight?: number;
	gap?: number;
	contentWidth?: number;
	placement?: 'header' | 'header-start' | 'header-end' | 'hidden';
	sameRow?: boolean;
	stack?: boolean;
	labelName?: string;
	labelPosition?: 'above' | 'below';
	seekStyle?: 'standard' | 'animated' | 'waveform';
	showElapsed?: boolean;
	showDuration?: boolean;
	showRemaining?: boolean;
	lyricsMode?: 'artwork' | 'sheet';
	width?: number;
	padding?: number;
	vAlign?: 'start' | 'center' | 'end';
	icon?: string;
	iconSize?: number;
	showLabel?: boolean;
	maxLines?: number;
	reserveLines?: boolean;
	align?: 'start' | 'center' | 'end';
	textSize?: 'small' | 'normal' | 'large';
	template?: string;
};
export const boardNames = {
	home: 'Home',
	library: 'Library',
	discover: 'Discover',
	player: 'Now Playing'
} as const;
const widgets: readonly { id: string; label: string }[] = [
	...libraryWidgets,
	...discoveryWidgets,
	...playerWidgets,
	...playerFields
];

export function available(board: LayoutTarget) {
	return widgets.filter((w) =>
		board === 'home' ? !w.id.startsWith('player-') : w.id.startsWith(board + '-')
	);
}

export function sectionTitle(section: Section) {
	return (
		section.filter?.name ||
		section.title ||
		uiText(widgets.find((w) => w.id === section.id)?.label ?? '') ||
		(isPlayerSlot(section.id)
			? uiText('Empty column')
			: isPlayerText(section.id)
				? uiText('Custom text')
				: section.id)
	);
}

export function defaults(board: LayoutTarget): Section[] {
	if (board === 'player') return defaultGridLayout();
	const ids =
		board === 'home'
			? ['library-recently-added', 'library-recently-played', 'discover-top_picks']
			: board === 'library'
				? libraryWidgets.filter((w) => w.id !== 'library-genres').map((w) => w.id)
				: defaultDiscoveryWidgets;
	return ids.map((id) => ({
		id,
		title: '',
		preview: true
	}));
}

const accounts = new WeakMap<Session, Promise<string>>();
export function accountId(session: Session): Promise<string> {
	if (session.userId) return Promise.resolve(session.userId);
	const pending = accounts.get(session);
	if (pending) return pending;
	// Installed versions before 0.3 kept the display name, which listeners can change.
	const lookup = getJson<{ id: string }>(session, '/api/v3/me')
		.then((me) => {
			if (typeof me.id !== 'string' || !me.id) throw new Error('Could not identify this listener.');
			return me.id;
		})
		.catch((error) => {
			accounts.delete(session);
			throw error;
		});
	accounts.set(session, lookup);
	return lookup;
}

function key(server: string, user: string, board: LayoutTarget) {
	return 'dn.mobile.layout.v1.' + JSON.stringify([server, user, board]);
}

// Sections are shared by Home and Library. Commit their definitions and board references together.
function boardsKey(server: string, user: string) {
	return 'dn.mobile.boards.v2.' + JSON.stringify([server, user]);
}
type BoardStore = {
	layouts: Partial<Record<Board, unknown[]>>;
	filters: FilterSection[];
};
function readBoards(server: string, user: string): BoardStore {
	const empty: BoardStore = { layouts: {}, filters: [] };
	try {
		const data = JSON.parse(localStorage.getItem(boardsKey(server, user)) || 'null');
		if (
			!data?.layouts ||
			typeof data.layouts !== 'object' ||
			Array.isArray(data.layouts) ||
			!Array.isArray(data.filters)
		)
			return empty;
		return {
			layouts: data.layouts,
			filters: data.filters
				.filter(
					(f: FilterSection) =>
						f &&
						typeof f.id === 'string' &&
						isFilteredSection(f.id) &&
						typeof f.name === 'string' &&
						f.name.trim()
				)
				.map((f: FilterSection) => ({
					...libraryFilter(f),
					id: f.id,
					name: f.name.trim().slice(0, 64)
				}))
		};
	} catch {
		return empty;
	}
}
export function savedSections(server: string, user: string) {
	return readBoards(server, user).filters;
}

export function hasSavedPlayerLayout(server: string, user: string) {
	return localStorage.getItem(key(server, user, 'player')) !== null;
}
export function loadLayout(server: string, user: string, board: LayoutTarget): Section[] {
	const boards = board === 'player' ? null : readBoards(server, user);
	let legacyPlayerGrid = false;
	let entries: unknown = board === 'player' ? null : boards?.layouts[board];
	if (!Array.isArray(entries)) {
		const raw = localStorage.getItem(key(server, user, board));
		if (raw === null) return defaults(board);
		try {
			const stored = JSON.parse(raw);
			legacyPlayerGrid = board === 'player' && Array.isArray(stored);
			entries =
				board === 'player' && stored?.version === PLAYER_GRID_VERSION ? stored.sections : stored;
		} catch {
			return defaults(board);
		}
	}
	if (!Array.isArray(entries)) return defaults(board);
	const allowed = new Set(available(board).map((w) => w.id));
	const sections: Section[] = [];
	const seen = new Set<string>();
	for (const item of entries) {
		if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
		const filter =
			board === 'home' || board === 'library'
				? boards?.filters.find((f) => f.id === item.id)
				: undefined;
		if (
			!filter &&
			!allowed.has(item.id) &&
			!(
				board === 'player' &&
				(isPlayerText(item.id) ||
					isPlayerSlot(item.id) ||
					item.id === 'player-tools' ||
					item.id === 'player-menu')
			)
		)
			continue;
		seen.add(item.id);
		const section: Section = {
			id: item.id,
			title: typeof item.title === 'string' ? item.title.trim().slice(0, 64) : '',
			...(filter ? { filter } : {}),
			preview: item.preview !== false
		};
		if (board === 'player') {
			for (const measure of playerMeasurements) {
				const value: unknown = item[measure];
				if (validMeasurement(measure, value)) section[measure] = value;
			}
			if (
				item.placement === 'header' ||
				(isNavigation(item.id) && ['header-start', 'header-end', 'hidden'].includes(item.placement))
			)
				section.placement = item.placement;
			Object.assign(
				section,
				playerOptions(
					legacyPlayerGrid && item.grid ? { ...item, grid: upgradeV2GridRect(item.grid) } : item
				)
			);
			if (item.sameRow === true) section.sameRow = true;
			if (['start', 'center', 'end'].includes(item.vAlign)) section.vAlign = item.vAlign;
			if (isPlayerIcon(item.icon)) section.icon = item.icon;
			if (typeof item.showLabel === 'boolean') section.showLabel = item.showLabel;
			if (typeof item.reserveLines === 'boolean') section.reserveLines = item.reserveLines;
			if (['start', 'center', 'end'].includes(item.align)) section.align = item.align;
			if (['small', 'normal', 'large'].includes(item.textSize)) section.textSize = item.textSize;
			if (isPlayerText(item.id) && typeof item.template === 'string')
				section.template = item.template.slice(0, 512);
		} else if (item.display && typeof item.display === 'object') {
			section.display = boardDisplay(section.id, item.display, section.filter?.kind);
		}
		sections.push(section);
	}
	if (board !== 'player') return sections;
	// A partially written or hand-edited local layout can still supply usable field settings.
	if (sections.some((section) => section.grid) && !isPlayerGrid(sections)) {
		for (const section of sections) delete section.grid;
	}
	return expandLegacyTrack(sections);
}

export function saveLayout(
	server: string,
	user: string,
	board: LayoutTarget,
	sections: Section[],
	edits?: { before: FilterSection[]; after: FilterSection[] }
) {
	const layout = sections.map((s) => {
		const item = { ...s, title: s.title.trim() };
		delete item.filter;
		return item;
	});
	let filtersChanged = false;
	if (board === 'player') {
		const stored = layout.some((s) => s.grid)
			? { version: PLAYER_GRID_VERSION, sections: layout }
			: layout;
		localStorage.setItem(key(server, user, board), JSON.stringify(stored));
	} else {
		const state = readBoards(server, user);
		state.layouts[board] = layout;
		if (edits) {
			// An open layout editor may predate changes to another saved section in another tab.
			const previous = new Map(edits.before.map((f) => [f.id, JSON.stringify(f)]));
			const updates = edits.after.filter((f) => previous.get(f.id) !== JSON.stringify(f));
			const kept = new Set(edits.after.map((f) => f.id));
			const removed = new Set(edits.before.filter((f) => !kept.has(f.id)).map((f) => f.id));
			filtersChanged = updates.length > 0 || removed.size > 0;
			if (filtersChanged) {
				const definitions = new Map(state.filters.map((f) => [f.id, f]));
				for (const id of removed) definitions.delete(id);
				for (const f of updates) definitions.set(f.id, f);
				state.filters = [...definitions.values()];
			}
		}
		localStorage.setItem(boardsKey(server, user), JSON.stringify(state));
	}
	window.dispatchEvent(
		new CustomEvent('dn-layout-change', {
			detail: { server, user, board, filtersChanged }
		})
	);
}
