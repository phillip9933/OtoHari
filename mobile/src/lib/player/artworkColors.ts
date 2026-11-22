// Sample a small sRGB image into color families. A second strong color can
// supply the controls without averaging a two-color sleeve into muddy gray.
type RGB = [number, number, number];
const black: RGB = [0, 0, 0];
const white: RGB = [255, 255, 255];

function mix(a: RGB, b: RGB, amount: number): RGB {
	return [
		Math.round(a[0] + (b[0] - a[0]) * amount),
		Math.round(a[1] + (b[1] - a[1]) * amount),
		Math.round(a[2] + (b[2] - a[2]) * amount)
	];
}
function luminance([r, g, b]: RGB) {
	const linear = (value: number) => {
		const channel = value / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function ink(color: RGB) {
	// Crossover of the black and white WCAG contrast ratios.
	return luminance(color) > 0.17913 ? black : white;
}
function readable(color: RGB, against: RGB, towards: RGB, ratio: number) {
	const base = luminance(against);
	for (let step = 0; step < 16; step++) {
		const candidate = mix(color, towards, step / 16);
		const light = luminance(candidate);
		if (
			(towards === black ? light <= base : light >= base) &&
			(Math.max(light, base) + 0.05) / (Math.min(light, base) + 0.05) >= ratio
		)
			return candidate;
	}
	return towards;
}
const hex = (color: RGB) => '#' + color.map((c) => c.toString(16).padStart(2, '0')).join('');

export function artworkColors(pixels: Uint8ClampedArray) {
	const families = new Map<number, { sum: RGB; weight: number }>();
	for (let i = 0; i + 3 < pixels.length; i += 4) {
		const alpha = pixels[i + 3] / 255;
		if (alpha < 0.5) continue;
		const r = pixels[i],
			g = pixels[i + 1],
			b = pixels[i + 2];
		const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
		const bucket = families.get(key) ?? { sum: [0, 0, 0], weight: 0 };
		const weight = alpha * (1 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255);
		bucket.sum[0] += r * weight;
		bucket.sum[1] += g * weight;
		bucket.sum[2] += b * weight;
		bucket.weight += weight;
		families.set(key, bucket);
	}
	const swatches = [...families.values()].sort((a, b) => b.weight - a.weight);
	if (!swatches.length) return;
	const mean = (swatch: (typeof swatches)[number]): RGB => [
		Math.round(swatch.sum[0] / swatch.weight),
		Math.round(swatch.sum[1] / swatch.weight),
		Math.round(swatch.sum[2] / swatch.weight)
	];
	const dominant = mean(swatches[0]);
	let alternate = dominant;
	for (const swatch of swatches.slice(1)) {
		if (swatch.weight < swatches[0].weight * 0.15) break;
		const color = mean(swatch);
		if (Math.hypot(color[0] - dominant[0], color[1] - dominant[1], color[2] - dominant[2]) >= 70) {
			alternate = color;
			break;
		}
	}
	const foreground = ink(dominant);
	const background = mix(dominant, foreground === black ? white : black, 0.25);
	const surface = mix(background, foreground, 0.05);
	const raised = mix(background, foreground, 0.1);
	// Raised is the surface closest to foreground; meeting contrast here
	// also covers text and controls on the background and normal surface.
	const accent = readable(alternate, raised, foreground, 4.5);
	return {
		background: hex(background),
		surface: hex(surface),
		raised: hex(raised),
		text: hex(readable(mix(dominant, foreground, 0.88), raised, foreground, 7)),
		muted: hex(readable(dominant, raised, foreground, 4.5)),
		accent: hex(accent),
		onAccent: hex(ink(accent)),
		line: hex(readable(dominant, raised, foreground, 3))
	};
}

export type ArtworkPalette = NonNullable<ReturnType<typeof artworkColors>>;
