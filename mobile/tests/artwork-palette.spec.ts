import { expect, test } from '@playwright/test';
import { artworkColors } from '../src/lib/player/artworkColors';

function luminance(hex: string) {
	const channels = [1, 3, 5].map((start) => {
		const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string) {
	const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
	return (light + 0.05) / (dark + 0.05);
}

test('keeps the dominant cover color, finds an accent and ignores transparent pixels', () => {
	const red = [204, 52, 32, 255];
	const blue = [16, 56, 230, 255];
	const transparent = [0, 255, 0, 0];
	const cover = [...Array(10).fill(red), ...Array(6).fill(blue)];
	const extract = (pixels: number[][]) => artworkColors(new Uint8ClampedArray(pixels.flat()));
	const palette = extract(cover);
	expect(palette).toBeDefined();
	expect(palette?.background).toBe(extract([red])?.background);
	expect(palette?.accent).not.toBe(extract([red])?.accent);
	expect(extract([...Array(300).fill(transparent), ...cover])).toEqual(palette);
	expect(extract([transparent])).toBeUndefined();
	expect(extract([])).toBeUndefined();
});

test('keeps text and controls legible on the extracted background and both surfaces', () => {
	const levels = [0, 32, 64, 96, 128, 160, 192, 224, 255];
	let leastTextContrast = Infinity;
	let leastLineContrast = Infinity;
	let leastAccentContrast = Infinity;
	for (const red of levels) {
		for (const green of levels) {
			for (const blue of levels) {
				const color = [red, green, blue, 255];
				const opposite = [255 - red, 255 - green, 255 - blue, 255];
				const palette = artworkColors(new Uint8ClampedArray([...color, ...color, ...opposite]))!;
				for (const surface of [palette.background, palette.surface, palette.raised]) {
					for (const foreground of [palette.text, palette.muted, palette.accent]) {
						leastTextContrast = Math.min(leastTextContrast, contrast(foreground, surface));
					}
					leastLineContrast = Math.min(leastLineContrast, contrast(palette.line, surface));
				}
				leastAccentContrast = Math.min(
					leastAccentContrast,
					contrast(palette.onAccent, palette.accent)
				);
			}
		}
	}
	expect(leastTextContrast).toBeGreaterThanOrEqual(4.5);
	expect(leastLineContrast).toBeGreaterThanOrEqual(3);
	expect(leastAccentContrast).toBeGreaterThanOrEqual(4.5);
});
