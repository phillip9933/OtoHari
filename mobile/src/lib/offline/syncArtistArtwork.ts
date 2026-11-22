import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { DnError, getArtwork, getJson, type Session } from '../connection';
import { artistArtwork } from '../catalog/artistArtwork';
import { path } from '../catalog/catalog';
import { preferredOffline } from './media';
import { cacheUsage, storeValue } from './viewedMedia';
import { tr } from '../i18n';

export type ArtworkProgress = { checked: number; total: number; updated: number };
export async function syncArtistArtwork(
	session: Session,
	signal: AbortSignal,
	progress: (value: ArtworkProgress) => void
) {
	const policy = await cacheUsage(session, 'artwork');
	if (!policy.limit)
		throw new Error(
			tr(
				'Choose an artwork cache limit first.',
				'先にアートワークのキャッシュ上限を選択してください。'
			)
		);
	async function checkConnection() {
		signal.throwIfAborted();
		if (!navigator.onLine || (await preferredOffline(session)))
			throw new Error(
				tr(
					'Connect to DN and turn off offline mode to sync artwork.',
					'アートワークを同期するには、DN に接続してオフラインモードを解除してください。'
				)
			);
	}
	let after: string | undefined;
	const seen = new Set<string>();
	const counts = { checked: 0, total: 0, updated: 0 };
	do {
		await checkConnection();
		const page = await getJson<components['schemas']['ArtistPage']>(
			session,
			path('/api/v3/library/artists', {}, { limit: 100, after }),
			signal
		);
		counts.total = page.total;
		progress({ ...counts });
		for (const artist of page.items) {
			await checkConnection();
			const { art, fallbackArt } = artistArtwork(artist.artist_mbid, artist.id, artist.art_missing);
			for (const address of [art, fallbackArt]) {
				if (!address) continue;
				let source: string;
				try {
					source = await getArtwork(session, address, signal);
				} catch (error) {
					if (error instanceof DnError && (error.status === 404 || error.status === 202)) continue;
					throw error;
				}
				signal.throwIfAborted();
				if (await storeValue(session, 'artwork', address, source, policy.revision))
					counts.updated++;
				break;
			}
			counts.checked++;
			progress({ ...counts });
		}
		after = page.next || undefined;
		if (after && seen.has(after))
			throw new Error(tr('DN repeated an artwork page.', 'DN から同じページが返されました。'));
		if (after) seen.add(after);
	} while (after);
	return counts;
}
