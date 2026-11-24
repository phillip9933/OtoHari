import { audioLevels } from './audioAnalysis';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PlayerAccess, PlayerTrack, PlaybackFormat } from '../player';

type Source = Pick<PlayerAccess, 'serverUrl' | 'userId'> & { id: string; blob: Blob };
type NativeWaveform = {
	waveform(options: { trackId: string; request: string }): Promise<{ peaks: number[] }>;
	cancelWaveform(options: { request: string }): Promise<void>;
};
const native = registerPlugin<NativeWaveform>('DNPlayer');
let source: Source | null = null;
const cache = new Map<string, number[]>();

export function setBrowserWaveformSource(current: Source | null) {
	source = current;
}

export async function identifyAudio(blob: Blob, duration?: number): Promise<PlaybackFormat | null> {
	const head = new Uint8Array(await blob.slice(0, 8192).arrayBuffer());
	const text = new TextDecoder('latin1').decode(head);
	const view = new DataView(head.buffer);
	const mime = blob.type.toLowerCase().split(';')[0];
	const formats: Record<string, string> = {
		'audio/flac': 'FLAC',
		'audio/x-flac': 'FLAC',
		'audio/mpeg': 'MP3',
		'audio/mp3': 'MP3',
		'audio/aac': 'AAC',
		'audio/mp4': 'M4A',
		'audio/ogg': 'Ogg',
		'audio/opus': 'Opus',
		'audio/wav': 'WAV',
		'audio/x-wav': 'WAV'
	};
	const info: PlaybackFormat = { format: formats[mime] ?? '' };
	if (text.startsWith('fLaC') && head.length >= 42 && (head[4] & 127) === 0) {
		info.format = 'FLAC';
		info.sampleRate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
		info.bitDepth = 1 + (((head[20] & 1) << 4) | (head[21] >> 4));
	} else if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') {
		info.format = 'WAV';
		for (let off = 12; off + 24 <= head.length;) {
			const size = view.getUint32(off + 4, true);
			if (text.slice(off, off + 4) === 'fmt ' && size >= 16) {
				const codec = view.getUint16(off + 8, true);
				if (codec === 1 || codec === 3) info.format = 'PCM';
				info.sampleRate = view.getUint32(off + 12, true);
				info.bitrate = Math.round((view.getUint32(off + 16, true) * 8) / 1000);
				info.bitDepth = view.getUint16(off + 22, true);
				break;
			}
			off += 8 + size + (size & 1);
		}
	} else if (text.startsWith('OggS')) {
		info.format = text.includes('OpusHead') ? 'Opus' : text.includes('vorbis') ? 'Vorbis' : 'Ogg';
	} else if (text.startsWith('ID3')) info.format = 'MP3';
	if (!info.format) return null;
	if (!info.bitrate && duration && duration > 0)
		info.bitrate = Math.round((8 * blob.size) / duration / 1000);
	return info;
}

export async function trackWaveform(
	account: PlayerAccess,
	track: PlayerTrack,
	signal: AbortSignal
) {
	const key = JSON.stringify([
		account.serverUrl,
		account.userId,
		track.id,
		track.duration,
		track.streamUrl
	]);
	const known = cache.get(key);
	if (known) return known;
	let peaks: number[];
	if (Capacitor.isNativePlatform()) {
		const request = crypto.randomUUID();
		const cancel = () => {
			void native.cancelWaveform({ request }).catch(() => {});
		};
		if (signal.aborted) return [];
		signal.addEventListener('abort', cancel, { once: true });
		try {
			({ peaks } = await native.waveform({ trackId: track.id, request }));
		} finally {
			signal.removeEventListener('abort', cancel);
		}
	} else {
		if (
			!source ||
			source.id !== track.id ||
			source.serverUrl !== account.serverUrl ||
			source.userId !== account.userId
		)
			return [];
		peaks = (await audioLevels(source.blob, 'wave', track.duration, signal))?.levels ?? [];
	}
	if (
		signal.aborted ||
		!Array.isArray(peaks) ||
		!peaks.length ||
		peaks.length > 512 ||
		!peaks.every(Number.isFinite)
	)
		return [];
	const high = Math.max(0.001, ...peaks);
	const normalized = peaks.map((v) => Math.max(0, Math.min(1, v / high)));
	cache.set(key, normalized);
	if (cache.size > 128) cache.delete(cache.keys().next().value!);
	return normalized;
}
