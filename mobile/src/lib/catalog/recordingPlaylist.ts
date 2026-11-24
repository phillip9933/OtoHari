import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { postJson, type Session } from '../connection';
import { cover, path } from './catalog';
type S = components['schemas'];
export function addRecording(session: Session, id: string, song: S['TrackIntake']) {
	return postJson<S['AddTracksResponse']>(
		session,
		path('/api/v3/playlists/{playlist_id}/tracks', { playlist_id: id }),
		{
			tracks: [
				{
					track_name: song.track_title,
					artist_name: song.artist_name || 'Unknown Artist',
					album_name: song.album_title || 'Unknown Album',
					album_id: song.release_group_mbid,
					recording_mbid: song.recording_mbid,
					duration: song.duration_seconds,
					source_type: '',
					track_source_id: null,
					available_sources: null,
					cover_url: cover(song.release_group_mbid)
				}
			]
		} satisfies S['AddTracksBody']
	);
}
