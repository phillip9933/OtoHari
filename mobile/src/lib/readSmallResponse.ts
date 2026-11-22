import { Capacitor, registerPlugin } from '@capacitor/core';
import { combineSignals } from './abortSignals';

type Kind = 'search' | 'artwork' | 'preview';
type ReadResult = { status: number; type: string; data?: string };
const native = registerPlugin<{
	read(args: {
		id: string;
		url: string;
		server: string;
		token: string;
		kind: Kind;
	}): Promise<ReadResult>;
	cancel(args: { id: string }): Promise<void>;
}>('DNRead');

const previewBytes = 2 * 1024 * 1024;
const artworkBytes = 8 * 1024 * 1024;

async function limitedBlob(response: Response, limit: number) {
	const reader = response.body?.getReader();
	if (!reader) throw Error('The server returned an empty response.');
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let size = 0;
	try {
		if (Number(response.headers.get('content-length')) > limit)
			throw Error('Response is too large.');
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) throw Error('Response is too large.');
			chunks.push(new Uint8Array(value));
		}
		return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function base64(blob: Blob) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
		reader.onerror = () => reject(new Error('Could not read the response.'));
		reader.readAsDataURL(blob);
	});
}

export async function readSmallResponse(
	server: string,
	url: string,
	token: string,
	kind: Kind,
	signal?: AbortSignal
): Promise<ReadResult> {
	signal?.throwIfAborted();
	if (Capacitor.isNativePlatform()) {
		const id = crypto.randomUUID();
		const pending = native.read({ id, server, url, token, kind });
		const cancel = () => {
			void native.cancel({ id }).catch(() => {});
		};
		signal?.addEventListener('abort', cancel, { once: true });
		try {
			return await pending;
		} finally {
			signal?.removeEventListener('abort', cancel);
			signal?.throwIfAborted();
		}
	}
	const headers: Record<string, string> = {
		Authorization: 'Bearer ' + token,
		Accept:
			kind === 'preview'
				? 'audio/*, application/octet-stream'
				: kind === 'artwork'
					? 'image/*'
					: 'application/json'
	};
	if (kind === 'preview') headers.Range = 'bytes=0-' + (previewBytes - 1);
	const timeout = AbortSignal.timeout(30_000);
	const response = await fetch(url, {
		headers,
		signal: signal ? combineSignals(signal, timeout) : timeout,
		credentials: 'omit',
		redirect: 'error',
		cache: 'no-store',
		referrerPolicy: 'no-referrer'
	});
	const status = response.status;
	const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (kind === 'artwork' && status === 202) {
		await response.body?.cancel();
		return { status, type };
	}
	if (!response.ok) {
		if (type === 'application/json')
			return { status, type, data: await (await limitedBlob(response, 32768)).text() };
		await response.body?.cancel();
		return { status, type };
	}
	const valid =
		kind === 'preview'
			? status === 206 && /^(audio\/[^;]+|application\/(octet-stream|flac|ogg))$/.test(type)
			: status === 200 &&
				(kind === 'artwork'
					? /^image\/(jpeg|png|webp|avif|gif)$/.test(type)
					: type === 'application/json');
	if (!valid) {
		await response.body?.cancel();
		throw Error('The server returned an unsupported response.');
	}
	const blob = await limitedBlob(response, kind === 'preview' ? previewBytes : artworkBytes);
	return { status, type, data: kind === 'search' ? await blob.text() : await base64(blob) };
}
