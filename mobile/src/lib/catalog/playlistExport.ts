import { limitedBlob, ResponseSizeError } from '../limitedBlob';
import { downloadFile, nativeDocuments } from '../documentFiles';
import { Capacitor } from '@capacitor/core';
import { apiAddress, expiredSession, readFileResponse, type Session } from '../connection';
import { preferredOffline } from '../offline/media';
import { path } from './catalog';

export type ExportFormat = 'm3u8' | 'csv';
const maxExportBytes = 64 * 1024 * 1024; // Same limit as the native export writers.
const mime = { m3u8: 'audio/x-mpegurl', csv: 'text/csv' };
type Writer = { write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
type Picker = (options: {
	suggestedName: string;
	types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<Writer> }>;
function picker() {
	return (window as Window & { showSaveFilePicker?: Picker }).showSaveFilePicker;
}
export type PreparedExport = {
	filename: string;
	skipped: number | null;
	choose: boolean;
	save: () => Promise<'saved' | 'download' | 'cancelled'>;
	discard: () => void;
};
function prefixKey(s: Session) {
	return 'dn.mobile.playlist-export-prefix.v1.' + JSON.stringify([s.serverUrl, s.userId]);
}
export function readExportPrefix(s: Session) {
	try {
		return s.userId ? (localStorage.getItem(prefixKey(s)) ?? '') : '';
	} catch {
		return '';
	}
}
export function keepExportPrefix(s: Session, prefix: string) {
	if (s.userId)
		try {
			if (prefix) localStorage.setItem(prefixKey(s), prefix);
			else localStorage.removeItem(prefixKey(s));
		} catch {
			/* An export can succeed with read-only local settings. */
		}
}
export function exportPrefix(input: string) {
	const text = input.trim();
	if ([...text].length > 200 || /\p{Cc}/u.test(text))
		throw Error('Use a prefix of up to 200 characters without line breaks or control characters.');
	return text;
}
function portableStem(s: string) {
	let stem = s
		.replace(/[<>:"/\\|?*\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '_')
		.replace(/^[. ]+|[. ]+$/g, '');
	if (/^(?:con|prn|aux|nul|(?:com|lpt)[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
	let name = '',
		length = 0;
	const encoder = new TextEncoder();
	for (const c of [...stem].slice(0, 120)) {
		length += encoder.encode(c).length;
		if (length > 220) break;
		name += c;
	}
	return name.replace(/[. ]+$/, '') || 'playlist';
}
export function exportFilename(
	disposition: string | undefined,
	title: string,
	format: ExportFormat
) {
	const encoded = disposition?.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;\s]+)/i)?.[1];
	let unicode: string | undefined;
	if (encoded)
		try {
			unicode = decodeURIComponent(encoded);
		} catch {
			/* Fall back to the server's plain filename. */
		}
	const simple = disposition?.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
	for (const hint of [unicode, simple?.[1] ?? simple?.[2]?.trim()]) {
		if (hint && !/[\\/\p{Cc}]/u.test(hint) && hint.toLowerCase().endsWith('.' + format))
			return portableStem(hint.slice(0, -(format.length + 1))) + '.' + format;
	}
	return portableStem(title) + '.' + format;
}
function count(value?: string) {
	if (!value || !/^\d+$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}
function httpError(session: Session, code: string) {
	if (code === 'DN_UNAUTHORIZED') {
		expiredSession(session);
		return Error('Your DroppedNeedle session expired. Sign in again to export.');
	}
	const status = Number(code.split('_')[1]);
	if (status === 401)
		return Error(
			'The server or its sign-in proxy rejected the export. Check your connection and sign-in.'
		);
	if (status === 403 || status === 404)
		return Error(
			'This playlist is missing or is no longer shared with you. Reopen Playlists to check access.'
		);
	if (status >= 300 && status < 400)
		return Error(
			'DN redirected this export. Check your server address and sign-in proxy before retrying.'
		);
	if (status === 400)
		return Error(
			'DN rejected the export options. Check the prefix and file format, then try again.'
		);
	return Error('DN returned HTTP ' + status + '. Reconnect to your server and try again.');
}
export async function prepareExport(
	session: Session,
	playlist: { id: string; name: string },
	format: ExportFormat,
	prefix: string,
	signal: AbortSignal
): Promise<PreparedExport> {
	if (!playlist.id || ['.', '..'].includes(playlist.id) || /[\\/\p{Cc}]/u.test(playlist.id))
		throw Error('Reopen a playlist on your DroppedNeedle server to export it.');
	const route = path(
		'/api/v3/playlists/{playlist_id}/export',
		{ playlist_id: playlist.id },
		{ format, prefix: exportPrefix(prefix) || undefined }
	);
	if (!navigator.onLine || (await preferredOffline(session)))
		throw Error('Connect to DN and turn off Offline only in Settings to export a server playlist.');
	signal.throwIfAborted();
	if (Capacitor.isNativePlatform()) {
		const id = crypto.randomUUID(),
			cancel = () => {
				void nativeDocuments.discard({ id }).catch(() => {});
			};
		signal.addEventListener('abort', cancel, { once: true });
		const discard = () => {
			signal.removeEventListener('abort', cancel);
			cancel();
		};
		try {
			const headers = await nativeDocuments.prepare({
				id,
				serverUrl: session.serverUrl,
				url: apiAddress(session.serverUrl, route),
				token: session.token,
				format
			});
			signal.throwIfAborted();
			const filename = exportFilename(headers.contentDisposition, playlist.name, format);
			return {
				filename,
				skipped: count(headers.skippedTracks),
				choose: false,
				discard,
				async save() {
					signal.throwIfAborted();
					const result = await nativeDocuments.save({ id, filename });
					return result.saved ? 'saved' : 'cancelled';
				}
			};
		} catch (error) {
			discard();
			signal.throwIfAborted();
			const code = (error as { code?: string })?.code ?? '';
			if (code === 'DN_UNAUTHORIZED' || /^HTTP_\d{3}$/.test(code)) throw httpError(session, code);
			throw error;
		}
	}
	let response: Response;
	try {
		response = await readFileResponse(session, route, mime[format], signal);
	} catch (cause) {
		signal.throwIfAborted();
		throw Error(
			'Could not reach the export endpoint. Check your DN address, connection and sign-in proxy, then try again.',
			{ cause }
		);
	}
	if (response.status !== 200) {
		let code = 'HTTP_' + response.status;
		if (
			response.status === 401 &&
			response.headers.get('Content-Type')?.toLowerCase().includes('application/json')
		) {
			const payload = await limitedBlob(response, 8192)
				.then(async (blob) => JSON.parse(await blob.text()))
				.catch(() => null);
			signal.throwIfAborted();
			if (payload?.error?.code === 'UNAUTHORIZED') code = 'DN_UNAUTHORIZED';
		}
		if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
		throw httpError(session, code);
	}
	if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== mime[format]) {
		await response.body?.cancel().catch(() => {});
		throw Error(
			'DN returned a different file type. Check your server address and sign-in proxy before retrying.'
		);
	}
	const filename = exportFilename(
			response.headers.get('Content-Disposition') ?? undefined,
			playlist.name,
			format
		),
		skipped = count(response.headers.get('X-DroppedNeedle-Skipped-Tracks') ?? undefined);
	let blob: Blob | null;
	try {
		blob = await limitedBlob(response, maxExportBytes);
	} catch (cause) {
		signal.throwIfAborted();
		if (cause instanceof ResponseSizeError)
			throw Error('The playlist export exceeds 64 MiB.', { cause });
		throw Error(
			'The export transfer was interrupted. Check your connection and prepare the file again.',
			{ cause }
		);
	}
	signal.throwIfAborted();
	const start = (await blob.slice(0, 256).text()).trim();
	if (!start || start.startsWith('<'))
		throw Error(
			'DN returned a sign-in page or an empty response. Check your proxy and retry the export.'
		);
	signal.throwIfAborted();
	const select = picker();
	return {
		filename,
		skipped,
		choose: !!select,
		discard() {
			blob = null;
		},
		async save() {
			signal.throwIfAborted();
			if (!blob) throw Error('Prepare the export again before saving.');
			if (select) {
				let handle;
				try {
					handle = await select.call(window, {
						suggestedName: filename,
						types: [
							{
								description: format === 'csv' ? 'CSV playlist' : 'M3U8 playlist',
								accept: { [mime[format]]: ['.' + format] }
							}
						]
					});
				} catch (e) {
					if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
					throw Error(
						'The save picker could not open. Check this browser’s file permissions, then try again.',
						{ cause: e }
					);
				}
				signal.throwIfAborted();
				let writer: Writer;
				try {
					writer = await handle.createWritable();
				} catch {
					throw Error(
						'This destination is not writable. Choose another folder or file and try again.'
					);
				}
				try {
					await writer.write(blob);
					signal.throwIfAborted();
					await writer.close();
				} catch {
					await writer.abort().catch(() => {});
					throw Error(
						'Could not finish writing the playlist. Choose a writable destination with sufficient space.'
					);
				}
				return 'saved';
			}
			downloadFile(blob, filename);
			return 'download';
		}
	};
}
