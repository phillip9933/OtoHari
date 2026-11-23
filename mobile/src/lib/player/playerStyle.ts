import type { Section } from '../boards/layout';
import { expandLegacyTrack, isPlayerSlot, isPlayerText } from './composition';
import {
	playerOptionKeys,
	playerOptions,
	playerMeasurements,
	validMeasurement,
	isNavigation,
	isPlayerIcon,
	playerFields,
	playerWidgets
} from './layout';

import {
	isPlayerGrid,
	PLAYER_GRID_VERSION,
	toPlayerGrid,
	upgradeV2GridRect,
	validGridRect
} from './grid';

const format = 'droppedneedle-player-layout';
const keys = [
	...playerOptionKeys,
	'id',
	'title',
	'preview',
	'sameRow',
	'width',
	'align',
	'textSize',
	'template',
	'minHeight',
	'gap',
	'placement',
	'contentWidth',
	'padding',
	'vAlign',
	'icon',
	'iconSize',
	'showLabel',
	'maxLines',
	'reserveLines'
] as const satisfies readonly (keyof Section)[];
const knownIds = new Set<string>([...playerFields, ...playerWidgets].map((item) => item.id));
export const maxPlayerStyleBytes = 64 * 1024;
function fits(text: string) {
	return (
		text.length <= maxPlayerStyleBytes &&
		new TextEncoder().encode(text).byteLength <= maxPlayerStyleBytes
	);
}
function checkSize(text: string) {
	if (!fits(text)) throw Error('Use a layout no larger than 64 KiB.');
}
export function exportPlayerStyle(
	sections: Section[],
	spacing: 'readable' | 'compact' = 'readable'
) {
	// A layout can cross devices or accounts. Serialize only the composition fields.
	const fields = sections.map((s) =>
		Object.fromEntries(
			keys
				.filter((key) => s[key] !== undefined)
				.map((key) => {
					if (key === 'grid' && s.grid) {
						const { x, y, w, h } = s.grid;
						return [key, { x, y, w, h }];
					}
					return [key, s[key]];
				})
		)
	);
	const layout = {
		format,
		version: sections.some((s) => s.grid) ? PLAYER_GRID_VERSION : 1,
		sections: fields
	};
	if (spacing === 'readable') {
		const readable = JSON.stringify(layout, null, 2);
		if (fits(readable)) return readable;
	}
	const compact = JSON.stringify(layout);
	checkSize(compact);
	return compact;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readSection(item: unknown, index: number, version: number): Section {
	const label = `Element ${index + 1}`;
	if (!record(item)) throw Error(`${label} must be an object.`);
	const {
		id,
		title,
		preview,
		sameRow,
		align,
		textSize,
		template,
		placement,
		vAlign,
		icon,
		showLabel,
		reserveLines
	} = item;
	if (
		typeof id !== 'string' ||
		!(
			knownIds.has(id) ||
			id === 'player-tools' ||
			id === 'player-menu' ||
			isPlayerText(id) ||
			isPlayerSlot(id)
		)
	)
		throw Error(`${label} has an unknown player element ID.`);
	if (Object.keys(item).some((key) => !keys.some((known) => known === key)))
		throw Error(`${label} has an unknown option.`);
	if (typeof title !== 'string' || title.length > 64)
		throw Error(`${label} needs a title of up to 64 characters.`);
	if (typeof preview !== 'boolean') throw Error(`${label} needs a true or false preview option.`);
	if (sameRow !== undefined && typeof sameRow !== 'boolean')
		throw Error(`${label} has an invalid row setting.`);
	const grid = version === 2 ? upgradeV2GridRect(item.grid) : item.grid;
	if (
		item.grid !== undefined &&
		(version === 1 ||
			!validGridRect(grid) ||
			Object.keys(item.grid as object).some((key) => !['x', 'y', 'w', 'h'].includes(key)))
	)
		throw Error(`${label} has an invalid grid position or size.`);
	const measurements: Partial<Pick<Section, (typeof playerMeasurements)[number]>> = {};
	for (const name of playerMeasurements) {
		const value = item[name];
		if (value === undefined) continue;
		if (!validMeasurement(name, value)) throw Error(`${label} has an invalid ${name}.`);
		measurements[name] = value;
	}
	if (icon !== undefined && !isPlayerIcon(icon)) throw Error(`${label} has an invalid icon.`);
	if (vAlign !== undefined && vAlign !== 'start' && vAlign !== 'center' && vAlign !== 'end')
		throw Error(`${label} has an invalid vertical alignment.`);
	if (showLabel !== undefined && typeof showLabel !== 'boolean')
		throw Error(`${label} has an invalid label setting.`);
	if (reserveLines !== undefined && typeof reserveLines !== 'boolean')
		throw Error(`${label} has an invalid line reservation.`);
	if (align !== undefined && align !== 'start' && align !== 'center' && align !== 'end')
		throw Error(`${label} has an invalid alignment.`);
	if (
		textSize !== undefined &&
		textSize !== 'small' &&
		textSize !== 'normal' &&
		textSize !== 'large'
	)
		throw Error(`${label} has an invalid text size.`);
	if (
		template !== undefined &&
		(!isPlayerText(id) || typeof template !== 'string' || template.length > 512)
	)
		throw Error(`${label} has an invalid custom text template.`);
	if (
		placement !== undefined &&
		placement !== 'header' &&
		(!isNavigation(id) ||
			(placement !== 'header-start' && placement !== 'header-end' && placement !== 'hidden'))
	)
		throw Error(`${label} has an invalid navigation placement.`);
	return {
		...measurements,
		...playerOptions({ ...item, grid }, true),
		...(vAlign === undefined ? {} : { vAlign }),
		...(icon === undefined ? {} : { icon }),
		...(showLabel === undefined ? {} : { showLabel }),
		...(reserveLines === undefined ? {} : { reserveLines }),
		...(placement === undefined ? {} : { placement }),
		id,
		title,
		preview,
		...(sameRow === undefined ? {} : { sameRow }),
		...(align === undefined ? {} : { align }),
		...(textSize === undefined ? {} : { textSize }),
		...(template === undefined ? {} : { template })
	};
}
export function importPlayerStyle(text: string): Section[] {
	checkSize(text);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw Error('Enter valid layout JSON.');
	}
	if (
		!record(value) ||
		value.format !== format ||
		(value.version !== 1 && value.version !== 2 && value.version !== PLAYER_GRID_VERSION) ||
		!Array.isArray(value.sections)
	)
		throw Error('Use an OtoHari player layout in version 1, 2 or 3 format.');
	if (Object.keys(value).some((key) => !['format', 'version', 'sections'].includes(key)))
		throw Error('The layout includes an unknown field.');
	const version = value.version;
	const sections = value.sections.map((item, index) => readSection(item, index, version));
	const seen = new Set<string>();
	for (const item of sections) {
		if (seen.has(item.id)) throw Error('Each player element needs its own ID.');
		seen.add(item.id);
	}
	if (version >= 2) {
		if (!isPlayerGrid(sections))
			throw Error('Each element needs its own space inside the player grid.');
		return sections;
	}
	const migrated = expandLegacyTrack(sections);
	toPlayerGrid(migrated); // Reject old files too large to fit before offering to load them.
	return migrated;
}
