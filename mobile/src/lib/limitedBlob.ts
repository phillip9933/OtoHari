export class ResponseSizeError extends Error {
	constructor() {
		super('Response is too large.');
	}
}

// Fixed-size buffers also bound memory when a server sends many small chunks.
export async function limitedBlob(response: Response, limit: number) {
	const reader = response.body?.getReader();
	if (!reader) throw Error('The server returned an empty response.');
	const blocks: Uint8Array<ArrayBuffer>[] = [];
	let block: Uint8Array<ArrayBuffer> | undefined;
	let filled = 0,
		received = 0;
	try {
		if (Number(response.headers.get('Content-Length')) > limit) throw new ResponseSizeError();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.byteLength > limit - received) throw new ResponseSizeError();
			for (let offset = 0; offset < value.byteLength;) {
				if (!block || filled === block.byteLength) {
					block = new Uint8Array(Math.min(64 * 1024, limit - received));
					blocks.push(block);
					filled = 0;
				}
				const take = Math.min(block.byteLength - filled, value.byteLength - offset);
				block.set(value.subarray(offset, offset + take), filled);
				offset += take;
				filled += take;
				received += take;
			}
		}
		if (block) blocks[blocks.length - 1] = block.subarray(0, filled);
		return new Blob(blocks, { type: response.headers.get('Content-Type') ?? '' });
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}
