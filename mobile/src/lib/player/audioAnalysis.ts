// Analysis never asks Web Audio to decompress a complete network-provided file.
// PCM can be measured directly in bounded slices. Other formats use the normal
// streaming media decoder and read one small analyser window at a time.
import { combineSignals } from '../abortSignals';

type Shape = 'wave' | 'head' | 'tail';
const maxDuration = 3600;
const maxInput = 128 * 1024 * 1024;
const edgeStep = 0.1;
type Layout = {
	rate: number;
	channels: number;
	bits: number;
	floating: boolean;
	data: number;
	frames: number;
};

async function pcmLayout(blob: Blob): Promise<Layout | null> {
	const header = new DataView(await blob.slice(0, 65536).arrayBuffer());
	if (
		header.byteLength < 44 ||
		header.getUint32(0) !== 0x52494646 ||
		header.getUint32(8) !== 0x57415645
	)
		return null;
	let rate = 0,
		channels = 0,
		bits = 0,
		floating = false,
		stride = 0;
	for (let at = 12; at + 8 <= header.byteLength;) {
		const kind = header.getUint32(at),
			size = header.getUint32(at + 4, true),
			data = at + 8;
		if (kind === 0x666d7420 && size >= 16 && data + 16 <= header.byteLength) {
			const codec = header.getUint16(data, true);
			floating = codec === 3;
			channels = header.getUint16(data + 2, true);
			rate = header.getUint32(data + 4, true);
			stride = header.getUint16(data + 12, true);
			bits = header.getUint16(data + 14, true);
			if (
				(codec !== 1 && !floating) ||
				(floating && bits !== 32) ||
				![8, 16, 24, 32].includes(bits) ||
				channels < 1 ||
				channels > 8 ||
				rate < 8000 ||
				rate > 192000 ||
				stride !== (channels * bits) / 8
			)
				return null;
		} else if (kind === 0x64617461 && stride && size <= blob.size - data) {
			return { rate, channels, bits, floating, data, frames: Math.floor(size / stride) };
		}
		at = data + size + (size % 2);
	}
	return null;
}

function positions(duration: number, shape: Shape) {
	const count = shape === 'wave' ? 112 : Math.floor(Math.min(8, duration) / edgeStep + 1e-8);
	return Array.from({ length: count }, (_, i) =>
		shape === 'wave'
			? (i * duration) / count
			: shape === 'head'
				? i * edgeStep
				: duration - (i + 1) * edgeStep
	);
}
function amplitude(view: DataView, i: number, layout: Layout) {
	if (layout.floating) {
		const value = view.getFloat32(i, true);
		return Number.isFinite(value) ? Math.min(1, Math.abs(value)) : 0;
	}
	switch (layout.bits) {
		case 8:
			return (view.getUint8(i) - 128) / 128;
		case 16:
			return view.getInt16(i, true) / 32768;
		case 24:
			return (
				(view.getUint8(i) | (view.getUint8(i + 1) << 8) | (view.getInt8(i + 2) << 16)) / 8388608
			);
		default:
			return view.getInt32(i, true) / 2147483648;
	}
}
async function pcmLevels(blob: Blob, layout: Layout, shape: Shape, signal: AbortSignal) {
	const duration = layout.frames / layout.rate;
	if (!duration || duration > maxDuration) return null;
	const levels = [];
	const width = layout.bits / 8,
		stride = layout.channels * width;
	for (const time of positions(duration, shape)) {
		signal.throwIfAborted();
		const frame = Math.round(time * layout.rate);
		const frames = Math.min(
			layout.frames - frame,
			Math.ceil(layout.rate * (shape === 'wave' ? Math.min(duration / 112, 0.1) : edgeStep))
		);
		const begin = layout.data + frame * stride;
		const view = new DataView(await blob.slice(begin, begin + frames * stride).arrayBuffer());
		signal.throwIfAborted();
		let level = 0,
			count = 0;
		// A fixed number of frames per bin also bounds CPU for multichannel high resolution PCM.
		const step = Math.max(1, Math.floor(frames / 2048));
		for (let f = 0; f < frames; f += step)
			for (let c = 0; c < layout.channels; c++) {
				const sample = amplitude(view, f * stride + c * width, layout);
				level = shape === 'wave' ? Math.max(level, Math.abs(sample)) : level + sample * sample;
				count++;
			}
		levels.push(shape === 'wave' ? level : Math.sqrt(level / Math.max(1, count)));
	}
	return { duration, levels };
}

function mediaEvent(media: HTMLAudioElement, name: string, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			media.removeEventListener(name, ready);
			media.removeEventListener('error', fail);
			signal.removeEventListener('abort', fail);
		};
		const ready = () => {
			cleanup();
			resolve();
		};
		const fail = () => {
			cleanup();
			reject(Error('Audio analysis unavailable.'));
		};
		if (signal.aborted || media.error) {
			fail();
			return;
		}
		media.addEventListener(name, ready, { once: true });
		media.addEventListener('error', fail, { once: true });
		signal.addEventListener('abort', fail, { once: true });
	});
}
async function streamedLevels(blob: Blob, shape: Shape, signal: AbortSignal) {
	const media = document.createElement('audio');
	const context = new AudioContext();
	const url = URL.createObjectURL(blob);
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		media.pause();
		media.removeAttribute('src');
		media.load();
		void context.close().catch(() => {});
	};
	signal.addEventListener('abort', stop, { once: true });
	try {
		const ready = mediaEvent(media, 'loadedmetadata', signal);
		media.preload = 'auto';
		media.src = url;
		await ready;
		const duration = media.duration;
		if (!Number.isFinite(duration) || duration <= 0 || duration > maxDuration) return null;
		const input = context.createMediaElementSource(media),
			analyser = context.createAnalyser(),
			mute = context.createGain();
		analyser.fftSize = 1024;
		mute.gain.value = 0;
		input.connect(analyser);
		analyser.connect(mute);
		mute.connect(context.destination);
		// resume() can remain pending under autoplay restrictions. The job deadline closes the context.
		await new Promise<void>((resolve, reject) => {
			const aborted = () => reject(Error('Audio analysis timed out.'));
			if (signal.aborted) {
				aborted();
				return;
			}
			signal.addEventListener('abort', aborted, { once: true });
			context
				.resume()
				.then(resolve, reject)
				.finally(() => signal.removeEventListener('abort', aborted));
		});
		signal.throwIfAborted();
		await media.play();
		const samples = new Float32Array(analyser.fftSize),
			levels = [];
		for (const time of positions(duration, shape)) {
			signal.throwIfAborted();
			if (Math.abs(media.currentTime - time) > 0.01) {
				const moved = mediaEvent(media, 'seeked', signal);
				media.currentTime = time;
				await moved;
			}
			await new Promise<void>((resolve) =>
				setTimeout(resolve, Math.ceil((1000 * analyser.fftSize) / context.sampleRate) + 16)
			);
			signal.throwIfAborted();
			analyser.getFloatTimeDomainData(samples);
			let level = 0;
			for (const sample of samples)
				level = shape === 'wave' ? Math.max(level, Math.abs(sample)) : level + sample * sample;
			levels.push(shape === 'wave' ? level : Math.sqrt(level / samples.length));
		}
		return { duration, levels };
	} finally {
		signal.removeEventListener('abort', stop);
		stop();
		URL.revokeObjectURL(url);
	}
}

export async function audioLevels(
	blob: Blob,
	shape: Shape,
	duration: number | undefined,
	signal: AbortSignal
) {
	if (signal.aborted || !blob.size || blob.size > maxInput || (duration ?? 0) > maxDuration)
		return null;
	const deadline = combineSignals(signal, AbortSignal.timeout(15_000));
	try {
		const layout = await pcmLayout(blob);
		deadline.throwIfAborted();
		return layout
			? await pcmLevels(blob, layout, shape, deadline)
			: await streamedLevels(blob, shape, deadline);
	} catch {
		return null;
	}
}
