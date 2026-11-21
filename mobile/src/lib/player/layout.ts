import { validGridRect } from './grid';
import type { Section } from '../boards/layout';
export const playerWidgets = [
	{ id: 'player-artwork', label: 'Artwork', option: 'Use large artwork', enabled: true },
	{ id: 'player-track', label: 'Track details', option: 'Show album title', enabled: true },
	{
		id: 'player-timeline',
		label: 'Playback position',
		option: 'Show elapsed and total time',
		enabled: true
	},
	{
		id: 'player-transport',
		label: 'Playback controls',
		option: 'Use a large play button',
		enabled: true
	},
	{ id: 'player-modes', label: 'Playback modes', option: 'Show button labels', enabled: true },
	{ id: 'player-lyrics', label: 'Lyrics', option: '', enabled: false },
	{ id: 'player-more', label: 'More actions', option: '', enabled: false },
	{ id: 'player-up-next', label: 'Up next', option: 'Show upcoming tracks', enabled: true }
] as const;

export const navigationFields = [
	{ id: 'player-menu', label: 'Navigation menu' },
	{ id: 'player-close', label: 'Close player' },
	{ id: 'player-settings', label: 'Player settings' },
	{ id: 'player-queue', label: 'Play queue' },
	{ id: 'player-output', label: 'Cast and audio output' }
] as const;
export type NavigationId = (typeof navigationFields)[number]['id'];
export function isNavigation(id: string): id is NavigationId {
	return navigationFields.some((action) => action.id === id);
}
export const trackToolFields = [
	{ id: 'player-favorite', label: 'Favorite' },
	{ id: 'player-playlist', label: 'Add to playlist' },
	{ id: 'player-download', label: 'Offline download' },
	{ id: 'player-rating', label: 'Track rating' },
	{ id: 'player-quality', label: 'Audio quality' }
] as const;
export const playerFields = [
	...navigationFields,
	{ id: 'player-heading', label: 'Player heading' },
	{ id: 'player-sleep', label: 'Sleep timer' },
	...trackToolFields,
	{ id: 'player-seek', label: 'Seek bar' },
	{ id: 'player-title', label: 'Track title' },
	{ id: 'player-artist', label: 'Artist' },
	{ id: 'player-album', label: 'Album' },
	{ id: 'player-text', label: 'Custom text' },
	{ id: 'player-elapsed', label: 'Elapsed time' },
	{ id: 'player-duration', label: 'Duration' },
	{ id: 'player-remaining', label: 'Remaining time' },
	{ id: 'player-previous', label: 'Previous track' },
	{ id: 'player-toggle', label: 'Play or pause' },
	{ id: 'player-next', label: 'Next track' },
	{ id: 'player-repeat', label: 'Repeat' },
	{ id: 'player-shuffle', label: 'Shuffle upcoming' }
] as const;

const bounds = {
	width: [1, 12],
	contentWidth: [20, 100],
	minHeight: [0, 640],
	gap: [0, 32],
	padding: [0, 32],
	iconSize: [12, 64],
	maxLines: [0, 8]
} as const;
type Measurement = keyof typeof bounds;
export const playerMeasurements = Object.keys(bounds) as Measurement[];
export function validMeasurement(name: Measurement, value: unknown): value is number {
	const [min, max] = bounds[name];
	return (
		typeof value === 'number' &&
		(name === 'padding' ? Number.isFinite(value) : Number.isInteger(value)) &&
		value >= min &&
		value <= max
	);
}

// Old portable layouts may include an explicit glyph.
const legacyIcons = [
	'default',
	'none',
	'play',
	'circle-play',
	'square-play',
	'skip-back',
	'skip-forward',
	'rewind',
	'fast-forward',
	'shuffle',
	'repeat',
	'heart',
	'star',
	'disc',
	'music',
	'user-round',
	'album',
	'type',
	'list',
	'plus',
	'download',
	'settings',
	'cast',
	'chevron-down',
	'volume'
] as const;
export type PlayerIcon = (typeof legacyIcons)[number];
export function isPlayerIcon(value: unknown): value is PlayerIcon {
	return legacyIcons.some((icon) => icon === value);
}
export function isPlayerText(id: string) {
	return /^player-text(?:-(?:[2-9]|[1-9]\d+))?$/.test(id);
}
export function isPlayerMetadata(id: string) {
	return (
		['player-title', 'player-artist', 'player-album', 'player-heading'].includes(id) ||
		isPlayerText(id)
	);
}
export function usesFieldCaption(id: string) {
	return [
		'player-artwork',
		'player-track',
		'player-timeline',
		'player-seek',
		'player-transport',
		'player-modes',
		'player-quality',
		'player-rating',
		'player-elapsed',
		'player-duration',
		'player-remaining'
	].includes(id);
}
export function defaultFieldLabel(section: Section) {
	return (
		section.icon === 'none' ||
		['player-playlist', 'player-download', 'player-up-next'].includes(section.id)
	);
}
export function supportsPlayerLines(id: string) {
	return id === 'player-track' || isPlayerMetadata(id);
}
export function previousPlayerDefaults(): Section[] {
	return playerWidgets
		.filter((w) => w.id !== 'player-up-next')
		.flatMap<Section>((w) =>
			w.id === 'player-track'
				? ['player-title', 'player-artist', 'player-album'].map((id) => ({
						id,
						title: '',
						preview: true,
						padding: 0
					}))
				: w.id === 'player-modes'
					? [
							{ id: w.id, title: '', preview: w.enabled },
							{ id: 'player-sleep', title: '', preview: true }
						]
					: [{ id: w.id, title: '', preview: w.enabled }]
		);
}

export function legacyRowDefaults(): Section[] {
	const body = previousPlayerDefaults().filter(
		(s) => !['player-sleep', 'player-lyrics', 'player-more'].includes(s.id)
	);
	return [
		...body,
		{ id: 'player-quality', title: '', preview: true },
		{ id: 'player-lyrics', title: '', preview: false },
		{ id: 'player-sleep', title: '', preview: true, sameRow: true },
		{ id: 'player-more', title: '', preview: false, sameRow: true }
	];
}

export const playerOptionKeys = [
	'grid',
	'iconMode',
	'stack',
	'labelName',
	'labelPosition',
	'seekStyle',
	'showElapsed',
	'showDuration',
	'showRemaining',
	'lyricsMode'
] as const;
export function playerOptions(item: Record<string, unknown>, strict = false): Partial<Section> {
	const options: Partial<Section> = {};
	for (const key of playerOptionKeys) {
		const value = item[key];
		if (value === undefined) continue;
		if (key === 'grid' && validGridRect(value)) {
			const { x, y, w, h } = value;
			options.grid = { x, y, w, h };
		} else if (key === 'iconMode' && (value === 'fixed' || value === 'fill'))
			options.iconMode = value;
		else if (key === 'labelName' && typeof value === 'string' && value.length <= 64)
			options.labelName = value;
		else if (key === 'labelPosition' && (value === 'above' || value === 'below'))
			options.labelPosition = value;
		else if (
			key === 'seekStyle' &&
			(value === 'standard' || value === 'animated' || value === 'waveform')
		)
			options.seekStyle = value;
		else if (key === 'lyricsMode' && (value === 'artwork' || value === 'sheet'))
			options.lyricsMode = value;
		else if (
			(key === 'stack' ||
				key === 'showElapsed' ||
				key === 'showDuration' ||
				key === 'showRemaining') &&
			typeof value === 'boolean'
		)
			options[key] = value;
		else if (strict) throw Error(`Invalid player option ${key}.`);
	}
	return options;
}
export function fieldSizing(row: Section[], column: Section[]) {
	const height =
		Math.max(0, ...row.map((cell) => cell.minHeight ?? 0)) / Math.max(1, column.length);
	const button = Math.max(44, Math.round(height));
	return { button, face: Math.max(22, Math.round(button * 0.52)) };
}
