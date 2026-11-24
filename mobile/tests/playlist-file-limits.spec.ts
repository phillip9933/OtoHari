import { test, expect } from '@playwright/test';
import { limitedBlob, ResponseSizeError } from '../src/lib/limitedBlob';
import {
	coverCrop,
	CoverSizeError,
	CoverAnimationError
} from '../src/lib/catalog/playlistCoverImage';
import { coverFrameCount } from '../src/lib/catalog/coverFrames';

test('export response checks declared and streamed lengths and cancels an oversized transfer', async () => {
	for (const declared of [undefined, '2', '10']) {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
			},
			cancel() {
				cancelled = true;
			}
		});
		const response = new Response(stream, {
			headers: declared ? { 'Content-Length': declared } : undefined
		});
		await expect(limitedBlob(response, 4)).rejects.toBeInstanceOf(ResponseSizeError);
		expect(cancelled).toBe(true);
	}
	const valid = await limitedBlob(new Response('text'), 4);
	expect(await valid.text()).toBe('text');
});

test('cover metadata is checked before a bitmap is requested', async () => {
	const file = new Blob(['sample'], { type: 'image/png' });
	Object.defineProperty(file, 'size', { value: 13 * 1024 * 1024 });
	await expect(coverCrop(file)).rejects.toBeInstanceOf(CoverSizeError);
});

// Each fixture is a 3 × 2 image. Metadata reads do not allocate a pixel buffer.
const tinyCovers = {
	'image/png':
		'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR42mP8n2LEwMDAwMDAxAADAB2DAZn+ig39AAAAAElFTkSuQmCC',
	'image/jpeg':
		'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC0ASUl/9k=',
	'image/gif': 'R0lGODdhAwACAIEAAP9kMgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7',
	'image/webp':
		'UklGRjwAAABXRUJQVlA4IDAAAAAQAgCdASoDAAIAAUAmJaACdLoB+AH4AAPIAP7bUf/0YLgOB76X/3ZO2VyP+RAAAAA=',
	'image/avif':
		'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAKQAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAwAAAAIAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAMW1kYXQSAAoIGAQrRAQ0GhAyGxTHh4ZlAgggnlAAAABIWtlc1e64tMqDpvNZYA=='
};
test('supported cover formats retain a centered square without upscaling', async () => {
	for (const [type, encoded] of Object.entries(tinyCovers)) {
		const blob = new Blob([Uint8Array.from(Buffer.from(encoded, 'base64'))], { type });
		await expect(coverCrop(blob, 4)).rejects.toBeInstanceOf(CoverSizeError);
		expect(await coverCrop(blob)).toEqual({ x: 0, y: 0, side: 2, output: 2 });
	}
});
const tinyAnimations = {
	'image/gif':
		'R0lGODlhAwACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAwACAAAIBgABCBwYEAAh+QQBCgABACwAAAAAAwACAIEAAP8AAAAAAAAAAAAIBgABCBwYEAA7',
	'image/png':
		'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAADAAAAAgAAAAAAAAAAAAEACgAAP7ZcWAAAABBJREFUeNpj/M8ABUwwBgMAEykBAxjZqAsAAAAaZmNUTAAAAAEAAAADAAAAAgAAAAAAAAAAAAEACgAApMW2jAAAABlmZEFUAAAAAnjaY2Rg+M/AwMDAwMDEAAMAESsBA5haJgUAAAAASUVORK5CYII=',
	'image/webp':
		'UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAgAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAIAAAEAAGQAAAJWUDggMgAAADABAJ0BKgMAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAACAAABAABkAAAAVlA4IC4AAAA0AQCdASoDAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA'
};
test('counts encoded frames and their canvas area before decoding short animations', async () => {
	for (const [type, encoded] of Object.entries(tinyAnimations)) {
		const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
		expect(coverFrameCount(bytes, type)).toBe(2);
		const blob = new Blob([bytes], { type });
		await expect(coverCrop(blob, 8)).rejects.toBeInstanceOf(CoverAnimationError);
		expect((await coverCrop(blob)).output).toBe(2);
	}
});
