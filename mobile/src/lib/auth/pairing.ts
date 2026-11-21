import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import {
	CALLBACK,
	freshPairing,
	openReply,
	startHandoff
} from '../../../../frontend/src/routes/connect/mobile/handoff';
import {
	readSecret,
	removeSecret,
	serverAddress,
	verifyToken,
	saveSession,
	DnError,
	writeSecret,
	type Session
} from '../connection';

const PENDING = 'dn.mobile.pending';
const DEVICE = 'dn.mobile.device';
interface Pending {
	server: string;
	state: string;
	key: JsonWebKey;
	started: number;
	reply?: string;
}

// Order changes to the same secure-storage entry. A server change or a new
// sign-in can happen while the profile request for a previous phone session runs.
let changes = Promise.resolve();
function change<T>(edit: () => Promise<T>): Promise<T> {
	const next = changes.then(edit);
	changes = next.then(
		() => {},
		() => {}
	);
	return next;
}

export function cancelPairing() {
	return change(() => removeSecret(PENDING));
}

async function ifCurrent(state: string, edit: (pending: Pending) => Promise<void>) {
	return change(async () => {
		const current = await readSecret<Pending>(PENDING);
		if (current?.state !== state) return false;
		await edit(current);
		return true;
	});
}

export async function openSignIn(address: string) {
	const server = serverAddress(address);
	let device = await readSecret<string>(DEVICE);
	if (!device) {
		device = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
		await writeSecret(DEVICE, device);
	}
	const { request, privateKey } = await startHandoff(device);
	await change(() =>
		writeSecret(PENDING, {
			server,
			state: request.state,
			key: privateKey,
			started: Number(request.started)
		} satisfies Pending)
	);
	const url = new URL(server + '/connect/mobile');
	url.search = new URLSearchParams({ ...request }).toString();
	try {
		await Browser.open({ url: url.href });
	} catch (error) {
		await ifCurrent(request.state, () => removeSecret(PENDING));
		throw error;
	}
}

export function watchSignIn(
	connected: (session: Session) => void,
	failed: (cause: unknown, retryable: boolean) => void,
	checking: (server: string) => void
) {
	let closed = false;
	let verifying: string | undefined;
	async function finish(url?: string, launch = false) {
		const pending = await readSecret<Pending>(PENDING);
		if (closed || !pending || verifying === pending.state) return;
		if (!freshPairing(pending.started)) {
			if (
				(await ifCurrent(pending.state, () => removeSecret(PENDING))) &&
				!closed &&
				(url || pending.reply)
			)
				failed(new Error('This sign-in has expired. Start again.'), false);
			return;
		}
		// iOS can retain an earlier launch URL while this installation has a newer
		// verified pairing reply waiting for its profile request to finish.
		const reply = launch && pending.reply ? pending.reply : (url ?? pending.reply);
		if (!reply?.startsWith(CALLBACK + '#')) return;
		const token = await openReply(reply, pending.state, pending.key);
		if (!token || closed || verifying === pending.state) return;
		verifying = pending.state;
		try {
			if (
				!(await ifCurrent(pending.state, async (current) => {
					// Keep the encrypted reply through interruptions until DN verifies this phone.
					if (!current.reply) await writeSecret(PENDING, { ...current, reply });
				})) ||
				closed
			)
				return;
			if (Capacitor.getPlatform() === 'ios' && url) void Browser.close().catch(() => {});
			checking(pending.server);
			const session = await verifyToken(pending.server, token);
			await ifCurrent(pending.state, async () => {
				if (closed) return;
				if (!freshPairing(pending.started)) {
					await removeSecret(PENDING);
					failed(new Error('This sign-in has expired. Start again.'), false);
					return;
				}
				await saveSession(session);
				await removeSecret(PENDING);
				if (!closed) connected(session);
			});
		} catch (error) {
			const revoked =
				error instanceof DnError && error.status === 401 && error.code === 'UNAUTHORIZED';
			await ifCurrent(pending.state, async () => {
				if (revoked) await removeSecret(PENDING);
				if (!closed) failed(error, !revoked);
			});
		} finally {
			if (verifying === pending.state) verifying = undefined;
		}
	}
	async function retry(url?: string, launch = false) {
		try {
			await finish(url, launch);
		} catch (error) {
			if (!closed) failed(error, false);
		}
	}
	const listener = Capacitor.isNativePlatform()
		? App.addListener('appUrlOpen', ({ url }) => {
				void retry(url);
			})
		: null;
	if (listener) {
		void listener
			.then(async () => {
				const launch = await App.getLaunchUrl();
				if (!closed) await retry(launch?.url, true);
			})
			.catch((error) => {
				if (!closed) failed(error, false);
			});
	}
	return {
		retry: () => retry(),
		stop() {
			closed = true;
			void listener?.then((handle) => handle.remove()).catch(() => {});
		}
	};
}
