// Mobile browser transfers become Blobs. Enforce the limit on decoded HTTP bytes
// even if the server omits Content-Length or applies transport compression.
export const maxAudioBlobBytes = 256 * 1024 * 1024;

export async function audioBlob(
	response: Response,
	onprogress?: (fraction: number) => void,
	limit = maxAudioBlobBytes
) {
	const length = Number(response.headers.get('Content-Length'));
	const body = response.body;
	const tooLarge = () => Error('This audio file exceeds the available transfer limit.');
	if (length > limit) {
		await body?.cancel();
		throw tooLarge();
	}
	if (!body) throw Error('DroppedNeedle returned an empty audio file.');
	const encoding = response.headers.get('Content-Encoding');
	const report = response.status === 200 && length > 0 && (!encoding || encoding === 'identity');
	let received = 0;
	const bounded = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (chunk.byteLength > limit - received) throw tooLarge();
				received += chunk.byteLength;
				if (report && received < length) onprogress?.(received / length);
				controller.enqueue(chunk);
			}
		}),
		{ signal: AbortSignal.timeout(10 * 60_000) }
	);
	return new Response(bounded, { headers: response.headers }).blob();
}
