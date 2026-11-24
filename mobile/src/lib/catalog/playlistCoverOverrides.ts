import {
	coverCrop,
	CoverAnimationError,
	CoverFormatError,
	CoverSizeError
} from './playlistCoverImage';
import { readable } from 'svelte/store';
import { accountId } from '../boards/layout';
import type { Session } from '../connection';
import { tr } from '../i18n';

const changes = new EventTarget();
let opening: Promise<IDBDatabase> | undefined;

function database() {
	if (!opening) {
		opening = new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('dn.mobile.playlist-covers', 1);
			req.onupgradeneeded = () => req.result.createObjectStore('covers');
			req.onerror = () => reject(req.error);
			req.onsuccess = () => {
				const db = req.result;
				db.onversionchange = () => {
					db.close();
					opening = undefined;
				};
				resolve(db);
			};
		}).catch((error) => {
			opening = undefined;
			throw error;
		});
	}
	return opening;
}

async function keyFor(session: Session, playlist: string) {
	return JSON.stringify([session.serverUrl, await accountId(session), playlist]);
}

export function playlistCoverOverride(session: Session, playlist: string) {
	return readable<string | undefined>(undefined, (set) => {
		const controller = new AbortController();
		void (async () => {
			const [key, db] = await Promise.all([keyFor(session, playlist), database()]);
			if (controller.signal.aborted) return;
			let changed = false;
			changes.addEventListener(
				key,
				(event) => {
					changed = true;
					set((event as CustomEvent<string | undefined>).detail);
				},
				{ signal: controller.signal }
			);
			const request = db.transaction('covers').objectStore('covers').get(key);
			request.onsuccess = () => {
				if (
					!changed &&
					!controller.signal.aborted &&
					typeof request.result === 'string' &&
					/^data:image\/(webp|png);base64,/.test(request.result)
				)
					set(request.result);
			};
		})().catch(() => {
			/* Automatic artwork is available when device storage is unavailable. */
		});
		return () => controller.abort();
	});
}

export async function savePlaylistCover(session: Session, playlist: string, source?: string) {
	const [key, db] = await Promise.all([keyFor(session, playlist), database()]);
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction('covers', 'readwrite');
		tx.oncomplete = () => resolve();
		tx.onabort = () =>
			reject(
				tx.error ??
					Error(
						tr('Could not save playlist artwork.', 'プレイリストの画像を保存できませんでした。')
					)
			);
		const covers = tx.objectStore('covers');
		if (source) covers.put(source, key);
		else covers.delete(key);
	});
	changes.dispatchEvent(new CustomEvent(key, { detail: source }));
}

export async function forgetPlaylistCover(session: Session, playlist: string) {
	try {
		await savePlaylistCover(session, playlist);
	} catch {
		// The change on DN has already succeeded.
		console.warn('Could not remove artwork from device storage.');
	}
}

export async function coverFromFile(file: File) {
	let crop;
	try {
		crop = await coverCrop(file);
	} catch (error) {
		if (error instanceof CoverFormatError)
			throw Error(
				tr(
					'Choose a JPEG, PNG, WebP, GIF or AVIF image.',
					'JPEG、PNG、WebP、GIF、AVIFの画像を選んでください。'
				),
				{ cause: error }
			);
		if (error instanceof CoverAnimationError)
			throw Error(
				tr(
					'Choose a still image or a shorter animation for your cover.',
					'カバーには静止画または短いアニメーションを選んでください。'
				),
				{ cause: error }
			);
		if (error instanceof CoverSizeError)
			throw Error(
				tr(
					'Choose an image up to 12 MiB and 20 megapixels, with each side at most 8192 pixels.',
					'12 MiB、2,000万画素以下で、各辺が8192ピクセル以内の画像を選んでください。'
				),
				{ cause: error }
			);
		throw Error(
			tr('Could not read the image dimensions.', '画像のサイズを読み込めませんでした。'),
			{ cause: error }
		);
	}
	const image = await createImageBitmap(file, crop.x, crop.y, crop.side, crop.side, {
		resizeWidth: crop.output,
		resizeHeight: crop.output,
		resizeQuality: 'high'
	}).catch(() => {
		throw Error(tr('Could not read this image.', 'この画像を読み込めませんでした。'));
	});
	try {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = crop.output;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw Error(tr('Could not prepare this image.', 'この画像を処理できませんでした。'));
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/webp', 0.88);
	} finally {
		image.close();
	}
}
