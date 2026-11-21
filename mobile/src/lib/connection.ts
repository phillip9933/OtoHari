import { readSmallResponse } from './readSmallResponse';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { combineSignals } from './abortSignals';
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage';

export interface Session {
	userId?: string;
	serverUrl: string;
	token: string;
	displayName: string;
}

export class DnError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code = ''
	) {
		super(message);
	}
}

export class DnTransportError extends Error {}
async function overNetwork<T>(read: Promise<T>, signal?: AbortSignal) {
	try {
		return await read;
	} catch (cause) {
		signal?.throwIfAborted();
		throw new DnTransportError(
			cause instanceof Error ? cause.message : 'Could not reach DroppedNeedle.'
		);
	}
}
export function unreachableDn(cause: unknown) {
	return (
		cause instanceof DnTransportError ||
		(cause instanceof DnError && [0, 502, 503, 504].includes(cause.status))
	);
}

export function serverAddress(value: string): string {
	const input = value.trim();
	if (!input) throw new Error('Enter your DroppedNeedle server address.');
	let url: URL;
	try {
		url = new URL(input.includes('://') ? input : 'https://' + input);
	} catch {
		throw new Error('Enter a valid DroppedNeedle server address.');
	}
	const loopback = ['localhost', '[::1]', '127.0.0.1'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
		throw new Error('Use the HTTPS address of your DroppedNeedle server.');
	}
	if (url.username || url.password || url.search || url.hash)
		throw new Error('Use the server address without credentials, a query, or a fragment.');
	return url.origin + url.pathname.replace(/\/+$/, '');
}

export function apiAddress(server: string, path: string) {
	const base = serverAddress(server);
	if (
		!path.startsWith('/api/v3/') ||
		path.includes('\\') ||
		/%(?:2e|2f|5c)/i.test(path.split('?')[0])
	) {
		throw new Error('Invalid DroppedNeedle API address.');
	}
	const target = new URL(base + path);
	if (target.hash || !target.href.startsWith(base + '/api/v3/'))
		throw new Error('Invalid DroppedNeedle API address.');
	return target.href;
}

const memory = new Map<string, string>();
export async function readSecret<T>(key: string): Promise<T | null> {
	const text = Capacitor.isNativePlatform()
		? await SecureStorage.get(key, false, false)
		: memory.get(key);
	return typeof text === 'string' ? (JSON.parse(text) as T) : null;
}
export async function writeSecret(key: string, value: unknown) {
	const text = JSON.stringify(value);
	if (Capacitor.isNativePlatform()) {
		await SecureStorage.set(key, text, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
	} else {
		memory.set(key, text);
	}
}
export async function removeSecret(key: string) {
	if (Capacitor.isNativePlatform()) await SecureStorage.remove(key, false);
	memory.delete(key);
}

function webRequest(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: unknown,
	signal?: AbortSignal,
	timeout = 30000
) {
	return overNetwork(
		fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			credentials: 'omit',
			redirect: 'error',
			cache: 'no-store',
			signal: signal
				? combineSignals(signal, AbortSignal.timeout(timeout))
				: AbortSignal.timeout(timeout)
		}),
		signal
	);
}
export function readFileResponse(
	session: Session,
	path: string,
	accept: string,
	signal: AbortSignal
) {
	return webRequest(
		apiAddress(session.serverUrl, path),
		'GET',
		{ Accept: accept, Authorization: 'Bearer ' + session.token },
		undefined,
		signal,
		10 * 60_000
	);
}
export function expiredSession(session: Session) {
	window.dispatchEvent(new CustomEvent('dn-session-expired', { detail: session }));
}

async function request<T>(
	server: string,
	path: string,
	options: {
		session?: Session;
		method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
		body?: unknown;
		artwork?: boolean;
		expectNoContent?: boolean;
		signal?: AbortSignal;
	} = {}
): Promise<T> {
	const { session, method = 'GET', body, artwork, signal } = options;
	signal?.throwIfAborted();
	const url = apiAddress(server, path);
	const headers: Record<string, string> = { Accept: artwork ? 'image/*' : 'application/json' };
	if (session) headers.Authorization = 'Bearer ' + session.token;
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	let status: number;
	let data: unknown;
	let contentType: string;
	const nativeSearch =
		method === 'GET' &&
		signal &&
		Capacitor.isNativePlatform() &&
		/^\/api\/v3\/search(?:[/?]|$)/.test(path);
	if (session && (artwork || nativeSearch)) {
		const result = await overNetwork(
			readSmallResponse(server, url, session.token, artwork ? 'artwork' : 'search', signal),
			signal
		);
		status = result.status;
		contentType = result.type;
		data = result.data;
		if (contentType === 'application/json' && typeof data === 'string') {
			try {
				data = JSON.parse(data);
			} catch {
				if (status >= 200 && status < 300) throw Error('Invalid JSON from DroppedNeedle.');
			}
		}
	} else if (Capacitor.isNativePlatform()) {
		const result = await overNetwork(
			CapacitorHttp.request({
				method,
				url,
				headers,
				data: body,
				disableRedirects: true,
				responseType: 'json',
				connectTimeout: 10_000,
				readTimeout: 30_000
			}),
			signal
		);
		signal?.throwIfAborted();
		status = result.status;
		data = result.data;
		contentType =
			Object.entries(result.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
	} else {
		const response = await webRequest(url, method, headers, body, signal);
		status = response.status;
		contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('json')) {
			data = await response.json();
		}
	}
	if (status < 200 || status >= 300) {
		const problem = (data as { error?: { code?: string; message?: string } } | null)?.error;
		if (session && status === 401 && problem?.code === 'UNAUTHORIZED') {
			expiredSession(session);
		}
		throw new DnError(
			problem?.message ?? 'DroppedNeedle returned HTTP ' + status + '.',
			status,
			problem?.code
		);
	}
	if (options.expectNoContent && status !== 204) throw Error('Server sign-out was not confirmed.');
	if (artwork) {
		const mime = contentType.split(';')[0].trim().toLowerCase();
		if (
			!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(mime) ||
			typeof data !== 'string'
		) {
			throw new Error('This artwork format is unavailable.');
		}
		return ('data:' + mime + ';base64,' + data) as T;
	}
	if (status !== 204 && !contentType.toLowerCase().includes('json')) {
		throw new Error('This address did not return a DroppedNeedle API response.');
	}
	return data as T;
}

export function getJson<T>(session: Session, path: string, signal?: AbortSignal): Promise<T> {
	return request(session.serverUrl, path, { session, signal });
}
export function postJson<T>(
	session: Session,
	path: string,
	body?: unknown,
	signal?: AbortSignal
): Promise<T> {
	return request(session.serverUrl, path, { session, method: 'POST', body, signal });
}
export function mutateJson<T>(
	session: Session,
	path: string,
	method: 'PUT' | 'PATCH' | 'DELETE',
	body?: unknown
): Promise<T> {
	return request(session.serverUrl, path, { session, method, body });
}
export function putJson<T>(session: Session, path: string, body?: unknown): Promise<T> {
	return mutateJson(session, path, 'PUT', body);
}
export function getArtwork(session: Session, path: string): Promise<string> {
	return request(session.serverUrl, path, { session, artwork: true });
}

const SESSION_KEY = 'dn.mobile.session';

type DeviceToken = Pick<Session, 'serverUrl' | 'token'>;
type Revocation = DeviceToken & { queuedAt: number };
type Credentials = { active: Session | null; revocations: Revocation[] };
// DN v3 sessions expire absolutely after 30 days, including sessions issued before sign-out.
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const sameToken = (a: DeviceToken, b: DeviceToken) =>
	a.serverUrl === b.serverUrl && a.token === b.token;
let storageWrite = Promise.resolve();

async function credentials(): Promise<Credentials> {
	const value = await readSecret<Session | Credentials>(SESSION_KEY);
	return value && 'revocations' in value ? value : { active: value, revocations: [] };
}

function editCredentials(edit: (current: Credentials) => void) {
	const next = storageWrite.then(async () => {
		const current = await credentials();
		edit(current);
		// Change active login and pending revocations together, including on process termination.
		if (current.revocations.length) await writeSecret(SESSION_KEY, current);
		else if (current.active) await writeSecret(SESSION_KEY, current.active);
		else await removeSecret(SESSION_KEY);
		window.dispatchEvent(new Event('dn-device-sessions'));
	});
	storageWrite = next.catch(() => {});
	return next;
}

export async function restoreSession() {
	await storageWrite;
	const { active: session } = await credentials();
	if (!session || session.userId) return session;
	try {
		return await saveSession(await verifyToken(session.serverUrl, session.token));
	} catch {
		return session;
	}
}

export function forgetSession(expected: Session) {
	return editCredentials((current) => {
		if (current.active && sameToken(current.active, expected)) current.active = null;
	});
}

export async function pendingLogoutServers() {
	await storageWrite;
	return [...new Set((await credentials()).revocations.map((device) => device.serverUrl))];
}

const revoking = new Map<string, Promise<void>>();
function revoke(device: DeviceToken) {
	const key = JSON.stringify([device.serverUrl, device.token]);
	const pending = revoking.get(key);
	if (pending) return pending;
	const task = (async () => {
		try {
			// DN accepts repeat logout after a lost reply and returns 204 for revoked sessions.
			await request(device.serverUrl, '/api/v3/auth/logout', {
				method: 'POST',
				session: { ...device, displayName: '' },
				expectNoContent: true
			});
		} catch (e) {
			if (!(e instanceof DnError && e.status === 401 && e.code === 'UNAUTHORIZED')) return;
		}
		await editCredentials((current) => {
			current.revocations = current.revocations.filter((item) => !sameToken(item, device));
		});
	})().finally(() => revoking.delete(key));
	revoking.set(key, task);
	return task;
}

export async function retrySignOuts() {
	await storageWrite;
	const { revocations } = await credentials();
	const cutoff = Date.now() - sessionLifetime;
	if (revocations.some((item) => item.queuedAt <= cutoff)) {
		await editCredentials((current) => {
			current.revocations = current.revocations.filter((item) => item.queuedAt > cutoff);
		});
	}
	if (navigator.onLine) {
		for (const device of revocations) if (device.queuedAt > cutoff) await revoke(device);
	}
}

export async function signOut(session: Session) {
	const device = { serverUrl: session.serverUrl, token: session.token, queuedAt: Date.now() };
	await editCredentials((current) => {
		if (current.active && sameToken(current.active, device)) current.active = null;
		if (!current.revocations.some((item) => sameToken(item, device)))
			current.revocations.push(device);
	});
	if (navigator.onLine) await revoke(device);
}

export async function verifyToken(address: string, raw: string): Promise<Session> {
	const token = raw.trim();
	if (!token || /\s/.test(token)) throw new Error('Enter a DroppedNeedle device session token.');
	const session: Session = { serverUrl: serverAddress(address), token, displayName: '' };
	const me = await getJson<{ display_name: string; username?: string | null; id: string }>(
		session,
		'/api/v3/me'
	);
	if (typeof me.display_name !== 'string' || typeof me.id !== 'string')
		throw new Error('This server did not return a DroppedNeedle profile.');
	session.userId = me.id;
	session.displayName = me.display_name || me.username || me.id;
	return session;
}

export async function saveSession(session: Session) {
	await editCredentials((current) => {
		if (current.revocations.some((item) => sameToken(item, session)))
			throw Error('This device session is signing out. Sign in with a new session.');
		current.active = session;
	});
	return session;
}

export async function useToken(address: string, raw: string) {
	return saveSession(await verifyToken(address, raw));
}

export async function usePassword(
	server: string,
	username: string,
	password: string,
	jellyfin: boolean
) {
	const url = serverAddress(server);
	const path = jellyfin ? '/api/v3/auth/jellyfin/login' : '/api/v3/auth/login';
	const response = await request<{ token: string }>(url, path, {
		method: 'POST',
		body: { username, password, transport: 'bearer' }
	});
	if (!response.token) throw new Error('The server did not return a DroppedNeedle session.');
	return useToken(url, response.token);
}

export interface LoginMethods {
	local: boolean;
	jellyfin: boolean;
	oidc: boolean;
	plex: boolean;
	pairing: boolean;
}
export async function loginMethods(address: string): Promise<LoginMethods> {
	const server = serverAddress(address);
	const methods = await request<LoginMethods>(server, '/api/v3/auth/providers');
	if (typeof methods?.local !== 'boolean' || typeof methods.oidc !== 'boolean')
		throw new Error('Enter the address of a DroppedNeedle v3 server.');
	let pairing = false;
	if (Capacitor.isNativePlatform()) {
		try {
			const result = await CapacitorHttp.get({
				url: server + '/mobile-pairing.json',
				disableRedirects: true,
				connectTimeout: 5_000,
				readTimeout: 5_000
			});
			pairing = result.status === 200 && result.data?.droppedneedle_mobile_pairing === 1;
		} catch {
			/* Older servers do not publish the mobile pairing page. */
		}
	}
	return { ...methods, pairing };
}
