import { registerPlugin } from '@capacitor/core';
import type { PlaybackBridge, PlaybackDelivery, PlayerAccess, PlayerState } from '../player';
import type { Network, Profiles, TrackFades } from './streaming';
import type { SoundSettings } from './sound';
import type { EqualizerBridge } from './equalizer';

export type OutputDevice = { id: string; name: string; sonos?: boolean };
export type SonosRoom = {
	id: string;
	name: string;
	coordinator?: string;
	groupName: string;
	leaders: string[];
	members: number;
	volume?: number;
};
type OutputState = { destination: string };
export type SignalOutput = {
	delivery?: PlaybackDelivery;
	id?: string;
	remote?: boolean;
	destination?: string;
	route?: 'speaker' | 'earpiece' | 'wired' | 'bluetooth' | 'usb' | 'hdmi';
	outputRate?: number;
	equalizer?: boolean;
	replayGain?: SoundSettings['replayGain'];
	speed?: number;
};
interface OutputBridge {
	outputState(): Promise<OutputState>;
	findOutputs(): Promise<{ devices: OutputDevice[] }>;
	sonosRooms(): Promise<{ rooms: SonosRoom[] }>;
	setSonosGroup(options: { id: string; coordinator?: string }): Promise<void>;
	setSonosVolume(options: { id: string; volume: number }): Promise<void>;
	castTo(options: { id: string }): Promise<OutputState>;
	googleCast(): Promise<OutputState>;
	stopCasting(): Promise<OutputState>;
	castScreen(): Promise<void>;
}
interface FadeBridge {
	getTrackFade(): Promise<Partial<TrackFades> & { milliseconds?: number }>;
	setTrackFade(options: TrackFades): Promise<void>;
}
export const nativePlayer = registerPlugin<
	PlaybackBridge &
		EqualizerBridge &
		OutputBridge &
		FadeBridge & {
			signalPath(): Promise<SignalOutput>;
			widgetAction(options: {
				url: string;
				serverUrl: string;
				userId: string;
			}): Promise<{ opened: boolean }>;
			shuffleSelection(options: {
				serverUrl: string;
				userId: string;
				ids: string[];
				serverOrder: boolean;
			}): Promise<{ indices: number[] }>;
			soundSettings(options: Partial<SoundSettings>): Promise<SoundSettings>;
			restore(access: PlayerAccess & { profiles: Profiles }): Promise<PlayerState>;
			getStreamNetwork(): Promise<{ network: Network }>;
			setStreamProfiles(
				options: Pick<PlayerAccess, 'serverUrl' | 'userId'> & Profiles
			): Promise<void>;
		}
>('DNPlayer');
export const nativeOutput: OutputBridge = nativePlayer;
export const nativeFades: FadeBridge = nativePlayer;
export const airplay = registerPlugin<{ choose(): Promise<void> }>('DNOutputs');
