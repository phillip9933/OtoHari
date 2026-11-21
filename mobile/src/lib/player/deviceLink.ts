import { Capacitor } from '@capacitor/core';
import { get } from 'svelte/store';
import {
	connectDeviceLink,
	transferMbid,
	transferableQueue,
	type DeviceAdapter,
	type TransferQueue
} from '../../../../frontend/src/lib/features/player/playback/deviceLink';
import { cover, path, playerTrack } from '../catalog/catalog';
import { DnError, postJson, type Session } from '../connection';
import { player, type PlayerState } from '../player';

function snapshot(state: PlayerState): TransferQueue {
	const library = state.libraryWindow;
	if (library && (library.offset > 0 || library.more || library.total !== state.tracks.length)) {
		throw Error('Choose a fully loaded queue to move it to another player.');
	}
	return {
		index: state.index,
		playing: state.playing,
		position_ms: Math.round(state.position * 1000),
		tracks: state.tracks.map((t) => ({
			id: t.id,
			title: t.title,
			artist: t.artist,
			album: t.album,
			album_id: t.albumId,
			artist_id: t.artistId,
			duration: t.duration,
			format: t.format,
			track_number: t.trackNumber,
			disc_number: t.discNumber,
			artist_mbid: transferMbid(t.artistMbid),
			release_group_mbid: transferMbid(t.releaseGroupMbid),
			recording_mbid: transferMbid(t.recordingMbid),
			replaygain_track_gain: t.replayGainTrackDb,
			replaygain_album_gain: t.replayGainAlbumDb,
			replaygain_track_peak: t.replayGainTrackPeak,
			replaygain_album_peak: t.replayGainAlbumPeak
		}))
	};
}

export function connectMobileDevice(session: Session) {
	if (!session.userId) return;
	let lastTracks: PlayerState['tracks'] | undefined,
		possible = false;
	const read: DeviceAdapter['heartbeat'] = async (body, signal) => {
		try {
			return await postJson(session, path('/api/v3/playback/devices/sync'), body, signal);
		} catch (e) {
			if (e instanceof DnError && (e.status === 404 || e.status === 405))
				throw Error('Update your DN server to use player handoff.', { cause: e });
			throw e;
		}
	};
	return connectDeviceLink({
		scope: JSON.stringify([session.serverUrl, session.userId]),
		name:
			Capacitor.getPlatform() === 'ios'
				? 'iPhone'
				: Capacitor.getPlatform() === 'android'
					? 'Android phone'
					: 'Mobile player',
		heartbeat: read,
		command: (body, signal) =>
			postJson(session, path('/api/v3/playback/devices/control'), body, signal),
		status: () => {
			const s = get(player),
				current = s.tracks[s.index];
			if (lastTracks !== s.tracks) {
				lastTracks = s.tracks;
				try {
					possible = transferableQueue(snapshot(s));
				} catch {
					possible = false;
				}
			}
			return {
				title: current?.title,
				playing: s.playing,
				can_transfer: !!current && possible && !s.libraryWindow?.more && !s.libraryWindow?.offset
			};
		},
		capture: () => snapshot(get(player)),
		restore: async (q) => {
			const tracks = q.tracks.map((t) => ({
				...playerTrack(
					t.id,
					t.title,
					t.artist,
					t.album,
					cover(t.release_group_mbid, t.album_id),
					t.duration
				),
				albumId: t.album_id ?? undefined,
				artistId: t.artist_id ?? undefined,
				format: t.format ?? undefined,
				trackNumber: t.track_number ?? undefined,
				discNumber: t.disc_number ?? undefined,
				artistMbid: t.artist_mbid ?? undefined,
				releaseGroupMbid: t.release_group_mbid ?? undefined,
				recordingMbid: t.recording_mbid ?? undefined,
				replayGainTrackDb: t.replaygain_track_gain ?? undefined,
				replayGainAlbumDb: t.replaygain_album_gain ?? undefined,
				replayGainTrackPeak: t.replaygain_track_peak ?? undefined,
				replayGainAlbumPeak: t.replaygain_album_peak ?? undefined
			}));
			await player.resumeQueue(tracks, q.index, q.position_ms / 1000, q.playing, session);
		},
		playing: (play) => player.setPlaying(play),
		skip: (forward) => (forward ? player.next() : player.previous())
	});
}
