import { Capacitor } from '@capacitor/core';
import { nativePlayer } from './native';

export const playbackSpeeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type ReplayGainMode = 'off' | 'track' | 'album';
export type SoundSettings = { speed: number; replayGain: ReplayGainMode };

const key = 'dn.mobile.playback-speed';
export function browserSpeed() {
	const value = Number(localStorage.getItem(key));
	return playbackSpeeds.some((speed) => speed === value) ? value : 1;
}

export async function soundSettings(change: Partial<SoundSettings> = {}): Promise<SoundSettings> {
	if (Capacitor.isNativePlatform()) return nativePlayer.soundSettings(change);
	if (change.replayGain && change.replayGain !== 'off')
		throw Error('ReplayGain requires the native audio player.');
	if (change.speed !== undefined) {
		if (!playbackSpeeds.some((speed) => speed === change.speed))
			throw Error('Choose a supported playback speed.');
		localStorage.setItem(key, String(change.speed));
		window.dispatchEvent(new Event('dn-playback-speed'));
	}
	return { speed: browserSpeed(), replayGain: 'off' };
}
