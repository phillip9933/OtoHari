import { Capacitor } from '@capacitor/core';
import { downloadFile, nativeDocuments } from '../documentFiles';
import { maxPlayerStyleBytes } from './playerStyle';

export async function saveLayoutFile(text: string): Promise<'saved' | 'download' | 'cancelled'> {
	if (Capacitor.isNativePlatform())
		return (await nativeDocuments.saveLayout({ text })).saved ? 'saved' : 'cancelled';
	downloadFile(new Blob([text], { type: 'application/json' }), 'otohari-player-layout.json');
	return 'download';
}

export async function readLayoutFile(file: File) {
	if (file.size > maxPlayerStyleBytes) throw Error('Use a layout no larger than 64 KiB.');
	let bytes: ArrayBuffer;
	try {
		bytes = await file.slice(0, maxPlayerStyleBytes + 1).arrayBuffer();
	} catch {
		throw Error('Could not open this layout file. Choose it again.');
	}
	if (bytes.byteLength > maxPlayerStyleBytes) throw Error('Use a layout no larger than 64 KiB.');
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw Error('Could not read this layout as UTF-8 text.');
	}
}
