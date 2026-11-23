// The browser and the installed app share this handoff format. Only the
// initiating installation has the private key. A callback contains ciphertext.
export const CALLBACK = 'app.droppedneedle.mobile://connect';
export const PAIRING_TTL = 10 * 60_000;
const rsa = { name: 'RSA-OAEP', hash: 'SHA-256' };
const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

function decode(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
		c.charCodeAt(0)
	);
}

export interface Pairing {
	state: string;
	publicKey: string;
	device: string;
	started: string;
}

export async function startHandoff(device: string) {
	const keys = await crypto.subtle.generateKey(
		{ ...rsa, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
		true,
		['encrypt', 'decrypt']
	);
	const pub = await crypto.subtle.exportKey('jwk', keys.publicKey);
	if (!pub.n) throw new Error('Could not prepare this phone for sign-in.');
	const request = {
		started: String(Date.now()),
		publicKey: pub.n,
		state: encode(crypto.getRandomValues(new Uint8Array(32))),
		device
	};
	return { request, privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) };
}

export function readPairing(params: URLSearchParams): Pairing | null {
	const state = params.get('state') ?? '';
	const publicKey = params.get('publicKey') ?? '';
	const device = params.get('device') ?? '';
	const started = params.get('started') ?? '';
	if (
		!/^\d{13}$/.test(started) ||
		!freshPairing(Number(started)) ||
		!/^[A-Za-z0-9_-]{43}$/.test(state) ||
		!/^[A-Za-z0-9_-]{342}$/.test(publicKey) ||
		!/^[A-F0-9]{8}$/.test(device)
	)
		return null;
	return { state, publicKey, device, started };
}

export function freshPairing(started: number) {
	const age = Date.now() - started;
	return age >= 0 && age <= PAIRING_TTL;
}

export async function recipient(request: Pairing) {
	return crypto.subtle.importKey(
		'jwk',
		{ kty: 'RSA', n: request.publicKey, e: 'AQAB' },
		rsa,
		false,
		['encrypt']
	);
}

export async function sealToken(request: Pairing, key: CryptoKey, token: string) {
	const sealed = await crypto.subtle.encrypt(
		{ name: rsa.name, label: encoder.encode(request.state) },
		key,
		encoder.encode(token)
	);
	return (
		CALLBACK +
		'#' +
		new URLSearchParams({ state: request.state, reply: encode(new Uint8Array(sealed)) })
	);
}

export async function openReply(address: string, expectedState: string, privateKey: JsonWebKey) {
	const [destination, fragment] = address.split('#');
	if (destination !== CALLBACK || !fragment) return null;
	const data = new URLSearchParams(fragment);
	const reply = data.get('reply') ?? '';
	if (data.get('state') !== expectedState || !/^[A-Za-z0-9_-]{342}$/.test(reply)) return null;
	const key = await crypto.subtle.importKey('jwk', privateKey, rsa, false, ['decrypt']);
	const plain = await crypto.subtle.decrypt(
		{ name: rsa.name, label: encoder.encode(expectedState) },
		key,
		decode(reply)
	);
	return new TextDecoder().decode(plain);
}
