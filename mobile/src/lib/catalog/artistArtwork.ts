import { path } from './catalog';

export function artistArtwork(mbid?: string | null, localId?: string | null, knownMissing = false) {
	const mosaic = localId
		? path('/api/v3/library/artists/{id}/artwork', { id: localId }, { size: 250 })
		: undefined;
	if (!mbid || knownMissing)
		return { art: knownMissing && !mbid ? undefined : mosaic, fallbackArt: undefined };
	return {
		art: path('/api/v3/covers/artist/{artist_id}', { artist_id: mbid }, { size: 250 }),
		fallbackArt: mosaic
	};
}
