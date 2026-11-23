import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { mutateJson, postJson, type Session } from '../connection';
import { tr } from '../i18n';
import { path } from './catalog';

export async function updatePlaylistCover(session: Session, id: string, source?: string) {
	const endpoint = path('/api/v3/playlists/{playlist_id}/cover', { playlist_id: id });
	if (source === undefined) {
		await mutateJson(session, endpoint, 'DELETE');
	} else {
		const prefix = /^data:(image\/(?:webp|png|jpeg));base64,/.exec(source);
		const data = prefix && source.slice(prefix[0].length);
		if (!data || data.length > 4 * Math.ceil((5 * 1024 * 1024) / 3))
			throw Error(tr('Could not upload this image.', 'この画像をアップロードできませんでした。'));
		await postJson(session, endpoint, {
			content_type: prefix[1],
			image_base64: data
		} satisfies components['schemas']['CoverUploadBody']);
	}
	window.dispatchEvent(new Event('dn-playlists-updated'));
}
