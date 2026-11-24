import { coverFrameCount, CoverSizeError } from './coverFrames';
import { JPG } from 'image-size/types/jpg';
import { PNG } from 'image-size/types/png';
import { GIF } from 'image-size/types/gif';
import { WEBP } from 'image-size/types/webp';
import { HEIF } from 'image-size/types/heif';

const formats = {
	'image/jpeg': JPG,
	'image/png': PNG,
	'image/gif': GIF,
	'image/webp': WEBP,
	'image/avif': HEIF
} as const;
export class CoverAnimationError extends Error {}
export { CoverSizeError } from './coverFrames';
export class CoverFormatError extends Error {}

export async function coverCrop(file: Blob, pixelLimit = 20_000_000) {
	if (!Object.hasOwn(formats, file.type)) throw new CoverFormatError();
	if (file.size > 12 * 1024 * 1024) throw new CoverSizeError();
	// Dimension readers only see a bounded header; image pixels have not been decoded.
	const bytes = new Uint8Array(await file.arrayBuffer());
	const header = bytes.subarray(0, 256 * 1024);
	const reader = formats[file.type as keyof typeof formats];
	if (!reader.validate(header)) throw new Error('Unknown image header.');
	const frames = coverFrameCount(bytes, file.type, pixelLimit);
	if (frames > 32) throw new CoverAnimationError();
	const metadata = reader.calculate(header);
	for (const { width, height } of [metadata, ...(metadata.images ?? [])]) {
		if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
			throw Error('Invalid image dimensions.');
		if (width > 8192 || height > 8192 || width * height > pixelLimit) throw new CoverSizeError();
	}
	if (metadata.width * metadata.height * frames > pixelLimit) throw new CoverAnimationError();
	if (
		metadata.images &&
		metadata.images.reduce((sum, item) => sum + item.width * item.height, 0) > pixelLimit
	)
		throw new CoverSizeError();
	const rotated =
		metadata.orientation != null && metadata.orientation >= 5 && metadata.orientation <= 8;
	const width = rotated ? metadata.height : metadata.width;
	const height = rotated ? metadata.width : metadata.height;
	const side = Math.min(width, height);
	return {
		x: Math.floor((width - side) / 2),
		y: Math.floor((height - side) / 2),
		side,
		output: Math.min(side, 512)
	};
}
