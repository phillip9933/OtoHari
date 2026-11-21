import { Capacitor } from '@capacitor/core';
import { writable } from 'svelte/store';
import { streamAddress, streamProfiles, original, type Profiles } from './player/streaming';
import type { LibraryContinuation, LibraryWindowStatus } from './player/libraryWindow';
import { browserPlayer } from './player/browser';
import type { EqualizerBridge } from './player/equalizer';
import { nativePlayer as native } from './player/native';
import { tr } from './i18n';

export interface PlayerTrack {
	id: string;
	title: string;
	artist: string;
	album: string;
	streamUrl: string;
	artworkUrl?: string;
	duration?: number;
	albumId?: string;
	artistId?: string;
	artistMbid?: string;
	recordingMbid?: string;
	releaseGroupMbid?: string;
	replayGainTrackDb?: number;
	replayGainAlbumDb?: number;
	replayGainTrackPeak?: number;
	replayGainAlbumPeak?: number;
	albumArtist?: string;
	albumArtistId?: string;
	genre?: string;
	year?: number;
	trackNumber?: number;
	discNumber?: number;
	dateAdded?: number;
	favorite?: boolean;
	format?: string;
	sourceSampleRate?: number;
	sourceBitDepth?: number;
	sourceBitrate?: number;
	rating?: number;
}

export interface PlayerAccess {
	userId?: string;
	serverUrl: string;
	token: string;
}

export type QueuePlacement = 'next' | 'upNext' | 'end';
export function placementMessage(placement: QueuePlacement) {
	if (placement === 'upNext') return tr('Added to Up Next.', '次の再生リストに追加しました。');
	return placement === 'next'
		? tr('Added to play next.', '次に再生する曲に追加しました。')
		: tr('Added to queue.', 'キューに追加しました。');
}
export type RepeatMode = 'off' | 'all' | 'one';

export type SleepTimerState =
	| { mode: 'minutes'; endsAt: number; finishTrack?: boolean }
	| { mode: 'track'; remaining?: number };

/** Measurements for the audio representation the player actually opened. */
export type PlaybackFormat = {
	format: string;
	sampleRate?: number;
	bitDepth?: number;
	bitrate?: number;
};
export type PlaybackDelivery = {
	mime?: string;
	source: 'network' | 'device' | 'cached' | 'downloaded' | 'automatic';
	network?: 'wifi' | 'cellular' | 'unknown' | 'offline';
	profile?: 'wifi' | 'cellular';
	requestedFormat?: string;
	requestedRate?: number;
	response?: 'original' | 'fallback' | 'converted';
};

export interface PlayerState {
	queueVersion?: string;
	upNext?: number[];
	shuffled?: boolean;
	hasPreviousQueue?: boolean;
	autoplay?: boolean;
	autoplayProblem?: string;
	libraryWindow?: LibraryWindowStatus | null;
	sleepTimer?: SleepTimerState | null;
	quality?: PlaybackFormat | null;
	delivery?: PlaybackDelivery;
	repeat: RepeatMode;
	tracks: PlayerTrack[];
	index: number;
	playing: boolean;
	position: number;
	duration: number;
	error: string | null;
}

export type PlayerAction =
	| 'toggle'
	| 'seek'
	| 'skipTo'
	| 'next'
	| 'previous'
	| 'clear'
	| 'move'
	| 'prioritize'
	| 'remove'
	| 'clearUpcoming'
	| 'shuffleUpcoming'
	| 'restorePreviousQueue'
	| 'setPlaying'
	| 'setAutoplay'
	| 'retryAutoplay'
	| 'cycleRepeat'
	| 'setSleepMinutes'
	| 'sleepAfterTrack'
	| 'cancelSleepTimer'
	| 'retryLibraryWindow';
type PlayerPoll = Omit<PlayerState, 'tracks'> & { tracks?: PlayerTrack[] };
export interface PlaybackBridge {
	autoplaySetting(
		options: Pick<PlayerAccess, 'serverUrl' | 'userId'> & { enabled?: boolean }
	): Promise<{ enabled: boolean }>;
	setQueue(
		options: PlayerAccess & {
			tracks: PlayerTrack[];
			index: number;
			placement?: QueuePlacement;
			positionSeconds?: number;
			playing?: boolean;
			profiles?: Profiles;
			continuation?: LibraryContinuation;
		}
	): Promise<PlayerState>;
	command(options: { action: PlayerAction; value?: number; to?: number }): Promise<PlayerState>;
	getState(): Promise<PlayerState>;
	getState(options: { knownQueue?: string }): Promise<PlayerPoll>;
}

const empty: PlayerState = {
	repeat: 'off',
	tracks: [],
	index: -1,
	playing: false,
	position: 0,
	duration: 0,
	error: null
};
export const nativeEqualizer: EqualizerBridge = native;
const backend: PlaybackBridge = Capacitor.isNativePlatform() ? native : browserPlayer();
let latest = empty;
let polling = false;
let pendingActions = 0;
let sequence = 0,
	queueRevision = 0;
const queueEdits = new Set<PlayerAction>([
	'clear',
	'move',
	'prioritize',
	'remove',
	'clearUpcoming',
	'shuffleUpcoming',
	'restorePreviousQueue'
]);
const state = writable(empty, () => {
	const timer = setInterval(() => {
		if (!document.hidden) void refresh();
	}, 1000);
	document.addEventListener('visibilitychange', refresh);
	void refresh();
	return () => {
		clearInterval(timer);
		document.removeEventListener('visibilitychange', refresh);
	};
});

function publish(next: PlayerState) {
	latest = next;
	state.set(next);
}

function reportPlayback(error: unknown) {
	state.update((value) => ({
		...value,
		error: error instanceof Error ? error.message : 'Playback failed.'
	}));
}

async function update(operation: () => Promise<PlayerState>) {
	const ticket = ++sequence;
	pendingActions++;
	try {
		const next = await operation();
		if (ticket === sequence) publish(next);
	} catch (error) {
		if (ticket === sequence) reportPlayback(error);
		throw error;
	} finally {
		pendingActions--;
	}
}

async function refresh() {
	if (document.hidden || polling || pendingActions) return;
	polling = true;
	const ticket = sequence;
	const previous = latest;
	try {
		const next = await backend.getState({ knownQueue: previous.queueVersion });
		if (ticket !== sequence) return;
		if (next.tracks) {
			publish({ ...next, tracks: next.tracks });
		} else if (next.queueVersion && next.queueVersion === previous.queueVersion) {
			// Native players omit all three queue-sized arrays for an unchanged revision.
			publish({
				...next,
				tracks: previous.tracks,
				upNext: previous.upNext,
				libraryWindow: next.libraryWindow
					? { ...next.libraryWindow, extras: previous.libraryWindow?.extras }
					: next.libraryWindow
			});
		} else {
			// Recover in case a restarted service returns a delta for a different queue.
			const full = await backend.getState();
			if (ticket === sequence) publish(full);
		}
	} catch (error) {
		if (ticket === sequence) reportPlayback(error);
	} finally {
		polling = false;
	}
}

function command(action: PlayerAction, value?: number, to?: number) {
	if (queueEdits.has(action)) queueRevision++;
	window.dispatchEvent(new Event('dn-playback-intent'));
	return update(() => backend.command({ action, value, to }));
}

// Capture occurrence order separately from the changing transport position and active track.
export function queueOrder(state: PlayerState) {
	return JSON.stringify([
		queueRevision,
		state.libraryWindow?.offset ?? null,
		state.tracks.map((track) => [track.id, track.streamUrl, track.title, track.artist, track.album])
	]);
}

async function editOccurrence(
	action: 'move' | 'prioritize',
	from: number,
	to?: number,
	expected?: string
) {
	if (expected === undefined) return command(action, from, to);
	let moved = false;
	await update(async () => {
		const current = await backend.getState();
		if (queueOrder(current) !== expected) return current;
		queueRevision++;
		window.dispatchEvent(new Event('dn-playback-intent'));
		const next = await backend.command({ action, value: from, to });
		moved = true;
		return next;
	});
	if (!moved) throw Error('The play queue changed. Choose the track again.');
}

function mediaUrl(base: URL, address: string, prefix: string) {
	const url = new URL(address.replace(/^\/(?!\/)/, ''), base);
	if (
		url.origin !== base.origin ||
		url.username ||
		url.password ||
		!url.pathname.startsWith(base.pathname + prefix)
	) {
		throw new Error('The media address is outside this DroppedNeedle library.');
	}
	return url.href;
}

async function submitTracks(
	tracks: PlayerTrack[],
	index: number,
	access: PlayerAccess,
	placement?: QueuePlacement,
	continuation?: LibraryContinuation,
	start?: { positionSeconds: number; playing: boolean }
) {
	window.dispatchEvent(new Event('dn-playback-intent'));
	if (!Number.isInteger(index) || index < 0 || index >= tracks.length)
		throw new Error('Choose a track to play.');
	const base = new URL(access.serverUrl);
	if (
		base.protocol !== 'https:' ||
		!access.token ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	) {
		throw new Error('Playback requires a secure DroppedNeedle connection.');
	}
	base.pathname = base.pathname.replace(/\/?$/, '/');
	const profiles = streamProfiles(access);
	const queue = tracks.map((track) => ({
		...track,
		streamUrl: streamAddress(mediaUrl(base, track.streamUrl, 'api/v3/stream/local/'), original),
		artworkUrl: track.artworkUrl ? mediaUrl(base, track.artworkUrl, 'api/v3/') : undefined
	}));
	queueRevision++;
	return update(() =>
		backend.setQueue({
			...access,
			tracks: queue,
			index,
			placement,
			profiles,
			continuation,
			...start
		})
	);
}

export const player = {
	async restore(access: PlayerAccess) {
		if (Capacitor.isNativePlatform()) {
			await update(() =>
				native.restore({
					serverUrl: access.serverUrl,
					token: access.token,
					userId: access.userId,
					profiles: streamProfiles(access)
				})
			);
		}
	},
	subscribe: state.subscribe,
	setQueue: (
		tracks: PlayerTrack[],
		index: number,
		access: PlayerAccess,
		continuation?: LibraryContinuation
	) => submitTracks(tracks, index, access, undefined, continuation),
	resumeQueue: (
		tracks: PlayerTrack[],
		index: number,
		positionSeconds: number,
		playing: boolean,
		access: PlayerAccess
	) => {
		if (!Number.isFinite(positionSeconds) || positionSeconds < 0)
			throw Error('Invalid playback position.');
		return submitTracks(tracks, index, access, undefined, undefined, { positionSeconds, playing });
	},
	autoplaySetting: (access: PlayerAccess, enabled?: boolean) =>
		backend.autoplaySetting({ serverUrl: access.serverUrl, userId: access.userId, enabled }),
	setPlaying: (playing: boolean) => command('setPlaying', Number(playing)),
	restorePreviousQueue: () => command('restorePreviousQueue'),
	setAutoplay: (enabled: boolean) => command('setAutoplay', Number(enabled)),
	retryAutoplay: () => command('retryAutoplay'),
	enqueue: (tracks: PlayerTrack[], access: PlayerAccess, placement: QueuePlacement = 'end') =>
		submitTracks(tracks, 0, access, placement),
	move: (from: number, to: number, expected?: string) => editOccurrence('move', from, to, expected),
	prioritize: (index: number, expected?: string) =>
		editOccurrence('prioritize', index, undefined, expected),
	remove: (index: number) => command('remove', index),
	shuffleUpcoming: () => command('shuffleUpcoming'),
	clearUpcoming: () => command('clearUpcoming'),
	cycleRepeat: () => command('cycleRepeat'),
	setSleepMinutes: (minutes: number, finishTrack = false) =>
		command('setSleepMinutes', minutes, finishTrack ? 1 : 0),
	sleepAfterTrack: (count = 1) => command('sleepAfterTrack', count),
	cancelSleepTimer: () => command('cancelSleepTimer'),
	retryLibraryWindow: () => command('retryLibraryWindow'),
	toggle: () => command('toggle'),
	seek: (seconds: number) => command('seek', seconds),
	skipTo: (index: number) => command('skipTo', index),
	next: () => command('next'),
	previous: () => command('previous'),
	clear: () => command('clear')
};
