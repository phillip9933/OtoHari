export class CoverSizeError extends Error {}
// Inspect the encoded container before asking the platform for a bitmap. The caller
// caps the file size; this walk skips compressed data and never decodes pixels.
export function coverFrameCount(bytes: Uint8Array, type: string, pixelLimit = 20_000_000): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const tag = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4));
	const end = bytes.length;
	let frames = 0;
	if (type === 'image/gif') {
		const colorTableSize = (packed: number) => (packed & 128 ? 3 << ((packed & 7) + 1) : 0);
		let i = 13 + colorTableSize(view.getUint8(10));
		while (i < end) {
			const marker = bytes[i++];
			if (marker === 0x3b && frames) return frames;
			if (marker === 0x21)
				i++; // Extension label, then data sub-blocks.
			else if (marker === 0x2c) {
				const left = view.getUint16(i, true),
					top = view.getUint16(i + 2, true);
				const w = view.getUint16(i + 4, true),
					h = view.getUint16(i + 6, true);
				if (!w || !h || left + w > view.getUint16(6, true) || top + h > view.getUint16(8, true))
					throw Error('Invalid GIF image bounds.');
				i += 10 + colorTableSize(view.getUint8(i + 8)); // Descriptor, color table and LZW code size.
				frames++;
				if (frames > 32) return frames;
			} else break;
			// Both GIF extensions and image data end with a zero-length sub-block.
			while (i < end && bytes[i] !== 0) i += 1 + bytes[i];
			i++;
		}
		throw Error('Invalid GIF image.');
	}
	if (type === 'image/png') {
		let declared = 1;
		for (let i = 8; i + 12 <= end;) {
			const size = view.getUint32(i),
				name = tag(i + 4);
			if (size > end - i - 12) break;
			if (name === 'acTL') {
				if (size !== 8) break;
				declared = Math.max(declared, view.getUint32(i + 8));
			}
			if (name === 'fcTL') {
				if (size !== 26) break;
				// Frame dimensions and offsets are relative to the IHDR canvas.
				const width = view.getUint32(i + 12),
					height = view.getUint32(i + 16);
				if (
					!width ||
					!height ||
					width + view.getUint32(i + 20) > view.getUint32(16) ||
					height + view.getUint32(i + 24) > view.getUint32(20)
				)
					throw Error('Invalid PNG frame bounds.');
				frames++;
			}
			if (declared > 32 || frames > 32 || name === 'IEND') return Math.max(frames, declared);
			i += size + 12;
		}
		throw Error('Invalid PNG image.');
	}
	if (type === 'image/webp') {
		for (let i = 12; i < end;) {
			const size = view.getUint32(i + 4, true);
			if (size > end - i - 8) throw Error('Invalid WebP image.');
			if (tag(i) === 'ANMF') {
				if (size < 16 || tag(12) !== 'VP8X') throw Error('Invalid WebP frame.');
				const uint24 = (offset: number) =>
					view.getUint16(offset, true) + 65536 * view.getUint8(offset + 2);
				const x = 2 * uint24(i + 8),
					y = 2 * uint24(i + 11);
				if (x + uint24(i + 14) > uint24(24) || y + uint24(i + 17) > uint24(27))
					throw Error('Invalid WebP frame bounds.');
				frames++;
			}
			if (frames > 32) return frames;
			i += 8 + size + (size & 1);
		}
		return Math.max(1, frames);
	}
	if (type === 'image/avif') {
		// The re-encoder only needs a still picture. A movie box is an image
		// sequence whose decoded frame count cannot be established by ispe.
		let pictures = 0,
			pixels = 0,
			sequence = false;
		const parents = ['meta', 'iprp', 'ipco'];
		function inspect(start: number, stop: number, depth: number) {
			for (let i = start; i < stop;) {
				const length = view.getUint32(i) || stop - i,
					name = tag(i + 4);
				if (length < 8 || length > stop - i) throw Error('Invalid AVIF box.');
				if (depth === 0 && name === 'moov') sequence = true;
				if (depth === 3 && name === 'ispe') {
					if (length < 20) throw Error('Invalid AVIF image bounds.');
					// ispe is the uncropped coded size; a display crop may be much smaller.
					const w = view.getUint32(i + 12),
						h = view.getUint32(i + 16);
					pixels += w * h;
					if (++pictures > 32 || !w || !h || w > 8192 || h > 8192 || pixels > pixelLimit)
						throw new CoverSizeError();
				}
				if (name === parents[depth]) inspect(i + (depth === 0 ? 12 : 8), i + length, depth + 1);
				i += length;
			}
		}
		inspect(0, end, 0);
		if (sequence) return Infinity;
		if (!pictures) throw Error('Missing AVIF image bounds.');
	}
	return 1;
}
