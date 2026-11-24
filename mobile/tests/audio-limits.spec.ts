import { expect, test } from '@playwright/test';
import { audioBlob } from '../src/lib/player/audioTransfer';
import { audioLevels } from '../src/lib/player/audioAnalysis';

test('audio transfers count actual bytes and cancel an oversized stream', async () => {
	for (const headers of [{}, { 'Content-Length': '2' }, { 'Content-Encoding': 'gzip' }]) {
		let cancelled = false;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(2));
			},
			cancel() {
				cancelled = true;
			}
		});
		await expect(
			audioBlob(
				new Response(source, { headers: new Headers(headers as Record<string, string>) }),
				undefined,
				3
			)
		).rejects.toThrow(/transfer limit/);
		await expect.poll(() => cancelled).toBe(true);
	}
	const data = new Uint8Array([1, 2, 3]);
	const ok = await audioBlob(
		new Response(data, { headers: { 'Content-Length': '3', 'Content-Type': 'audio/wav' } }),
		undefined,
		3
	);
	expect(ok.size).toBe(3);
	expect(ok.type).toBe('audio/wav');
});

test('a bounded real PCM fixture is measurable and an oversized duration falls back', async () => {
	const data = Buffer.alloc(44 + 16000, 128);
	data.write('RIFF');
	data.writeUInt32LE(data.length - 8, 4);
	data.write('WAVEfmt ', 8);
	data.writeUInt32LE(16, 16);
	data.writeUInt16LE(1, 20);
	data.writeUInt16LE(1, 22);
	data.writeUInt32LE(8000, 24);
	data.writeUInt32LE(8000, 28);
	data.writeUInt16LE(1, 32);
	data.writeUInt16LE(8, 34);
	data.write('data', 36);
	data.writeUInt32LE(16000, 40);
	const clip = new Blob([new Uint8Array(data)], { type: 'audio/wav' });
	const signal = new AbortController().signal;
	const quiet = await audioLevels(clip, 'wave', undefined, signal);
	expect(quiet?.duration).toBe(2);
	expect(quiet?.levels).toEqual(Array(112).fill(0));
	expect(await audioLevels(clip, 'tail', 7200, signal)).toBeNull();
});
