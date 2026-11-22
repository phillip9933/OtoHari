import type { Session } from '../connection';
import { observeCover } from '../catalog/coverRequests';
import { artworkColors, type ArtworkPalette } from './artworkColors';
export type { ArtworkPalette } from './artworkColors';

export function readArtworkPalette(image: HTMLImageElement) {
	if (!image.naturalWidth || !image.naturalHeight) return;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 32;
		const context = canvas.getContext('2d');
		if (!context) return;
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		return artworkColors(context.getImageData(0, 0, canvas.width, canvas.height).data);
	} catch {
		// Embedded browsers may restrict pixel reads. Keep the selected theme.
		return undefined;
	}
}

export function watchArtworkPalette(
	session: Session,
	path: string | undefined,
	receive: (palette: ArtworkPalette | undefined) => void
) {
	receive(undefined);
	if (!path) return () => {};
	let current: HTMLImageElement | undefined;
	const unsubscribe = observeCover(session, path, (source) => {
		current = undefined;
		// The authenticated cover reader and offline companions return image data
		// URIs. Never give the image loader a separate network address.
		if (!/^data:image\/(jpeg|png|webp|avif|gif);base64,/i.test(source)) {
			receive(undefined);
			return;
		}
		const image = new Image();
		current = image;
		image.onload = () => {
			if (current === image) receive(readArtworkPalette(image));
		};
		image.onerror = () => {
			if (current === image) receive(undefined);
		};
		image.decoding = 'async';
		image.src = source;
	});
	return () => {
		unsubscribe();
		current = undefined;
	};
}
