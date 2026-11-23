import { get, writable } from 'svelte/store';
import type { components } from '../../../api/v3/openapi';

type Schemas = components['schemas'];
export type TransferQueue = Schemas['TransferQueue'];
export type LinkedDevice = Schemas['LinkedDevice'];
const localId = /^[a-zA-Z0-9_-]{1,128}$/;
const mbid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function transferMbid(value?: string | null) {
	return value && mbid.test(value) ? value : undefined;
}
const bytes = new TextEncoder();
export function transferableQueue(q: TransferQueue) {
	return (
		Number.isInteger(q.index) &&
		q.index >= 0 &&
		q.index < q.tracks.length &&
		q.tracks.length <= 2000 &&
		Number.isSafeInteger(q.position_ms) &&
		q.position_ms >= 0 &&
		q.position_ms <= 604800000 &&
		q.tracks.every(
			(t) =>
				localId.test(t.id) &&
				(!t.album_id || localId.test(t.album_id)) &&
				(!t.artist_id || localId.test(t.artist_id)) &&
				[t.title, t.album, t.artist].every(
					(s) => typeof s === 'string' && bytes.encode(s).length <= 1024
				) &&
				(!t.format || bytes.encode(t.format).length <= 64) &&
				(t.duration == null ||
					(Number.isFinite(t.duration) && t.duration >= 0 && t.duration <= 604800))
		) &&
		bytes.encode(JSON.stringify(q)).length <= 700000
	);
}
type Action = Schemas['DeviceAction'];
export interface DeviceAdapter {
	scope: string;
	name: string;
	heartbeat(
		body: Schemas['DeviceHeartbeat'],
		signal: AbortSignal
	): Promise<Schemas['DeviceUpdate']>;
	command(body: Schemas['DeviceControlRequest'], signal: AbortSignal): Promise<void>;
	status(): { title?: string; playing: boolean; can_transfer: boolean };
	capture(): TransferQueue;
	restore(queue: TransferQueue): Promise<void>;
	playing(play: boolean): Promise<void>;
	skip(forward: boolean): Promise<void>;
}
type LinkState = {
	enabled: boolean;
	name: string;
	id: string;
	devices: LinkedDevice[];
	issue: string;
	working: boolean;
};
const initial: LinkState = {
	enabled: false,
	name: '',
	id: '',
	devices: [],
	issue: '',
	working: false
};
const state = writable(initial);
let adapter: DeviceAdapter | undefined;
let owner: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let receipt: Schemas['DeviceReceipt'] | undefined;
let lastReceipt: Schemas['DeviceReceipt'] | undefined;
let requestRevision = 0;
const message = (e: unknown) =>
	e instanceof Error ? e.message : 'The player could not complete that action.';
const storageKey = (a: DeviceAdapter) => 'dn.device-control.v1.' + a.scope;
function patch(update: Partial<LinkState>) {
	state.update((s) => ({ ...s, ...update }));
}
function restart() {
	clearTimeout(timer);
	if (!polling && owner && get(state).enabled) void poll();
}
async function poll() {
	const current = adapter,
		lifecycle = owner;
	if (!current || !lifecycle || polling || !get(state).enabled) return;
	polling = true;
	const { name, id } = get(state);
	try {
		const update = await current.heartbeat(
			{ id, name, ...current.status(), receipt },
			lifecycle.signal
		);
		if (lifecycle.signal.aborted) return;
		if (!Array.isArray(update?.devices))
			throw Error('Update your DN server to use player handoff.');
		receipt = undefined;
		patch({ devices: update.devices, issue: update.devices.find((d) => d.id === id)?.error ?? '' });
		const cmd = update.command;
		if (cmd) {
			if (cmd.id === lastReceipt?.id) receipt = lastReceipt;
			else {
				let result: Schemas['DeviceReceipt'] = { id: cmd.id };
				try {
					if (cmd.action === 'transfer') {
						if (cmd.queue) await current.restore(cmd.queue);
						else {
							const queue = current.capture();
							if (!transferableQueue(queue))
								throw Error(
									'This player can transfer a fully loaded queue of up to 2,000 local DN tracks.'
								);
							await current.playing(false);
							result = { id: cmd.id, queue };
						}
					} else if (cmd.action === 'play' || cmd.action === 'pause')
						await current.playing(cmd.action === 'play');
					else await current.skip(cmd.action === 'next');
				} catch (error) {
					result = { id: cmd.id, error: message(error).slice(0, 180) };
				}
				if (lifecycle.signal.aborted) return;
				receipt = lastReceipt = result;
			}
		}
	} catch (error) {
		if (!lifecycle.signal.aborted) patch({ devices: [], issue: message(error) });
	} finally {
		if (!lifecycle.signal.aborted) {
			polling = false;
			const { issue } = get(state);
			timer = setTimeout(() => void poll(), receipt ? 0 : issue ? 12_000 : 2_000);
		}
	}
}
function stop() {
	clearTimeout(timer);
	owner?.abort();
	owner = undefined;
	polling = false;
	receipt = lastReceipt = undefined;
	requestRevision++;
}
function withdraw() {
	const a = adapter,
		s = get(state);
	if (a && s.enabled && s.id) {
		void a
			.heartbeat(
				{ id: s.id, name: s.name, playing: false, can_transfer: false, disconnect: true },
				AbortSignal.timeout(3000)
			)
			.catch(() => {});
	}
}
function setEnabled(enabled: boolean) {
	if (!adapter) return;
	if (!enabled) withdraw();
	stop();
	patch({ enabled, devices: [], issue: '', working: false });
	localStorage.setItem(storageKey(adapter), JSON.stringify({ enabled, name: get(state).name }));
	if (enabled) {
		owner = new AbortController();
		restart();
	}
}
function setName(value: string) {
	if (!adapter) return;
	const name = value.trim().slice(0, 60) || adapter.name;
	if (name === get(state).name) return;
	patch({ name });
	localStorage.setItem(storageKey(adapter), JSON.stringify({ enabled: get(state).enabled, name }));
	restart();
}
async function control(target: string, action: Action, destination?: string) {
	const a = adapter,
		lifecycle = owner;
	if (!a || !lifecycle || get(state).working) return;
	const revision = ++requestRevision;
	patch({ working: true, issue: '' });
	try {
		await a.command({ id: crypto.randomUUID(), target, action, destination }, lifecycle.signal);
		if (!lifecycle.signal.aborted) restart();
	} catch (error) {
		if (!lifecycle.signal.aborted) patch({ issue: message(error) });
	} finally {
		if (revision === requestRevision) patch({ working: false });
	}
}
export const deviceLink = {
	subscribe: state.subscribe,
	setEnabled,
	setName,
	control,
	refresh: restart
};
export function connectDeviceLink(next: DeviceAdapter) {
	stop();
	adapter = next;
	let saved: Partial<Pick<LinkState, 'name' | 'enabled'>> = {};
	try {
		saved = JSON.parse(localStorage.getItem(storageKey(next)) || '{}') ?? {};
	} catch {
		/* Use a new preference. */
	}
	// A tab has its own endpoint, including when two tabs share the same signed-in account.
	const id = crypto.randomUUID();
	state.set({
		...initial,
		id,
		name: typeof saved.name === 'string' && saved.name.trim() ? saved.name : next.name,
		enabled: saved.enabled === true
	});
	if (saved.enabled === true) {
		owner = new AbortController();
		restart();
	}
	window.addEventListener('online', restart);
	document.addEventListener('visibilitychange', restart);
	return () => {
		window.removeEventListener('online', restart);
		document.removeEventListener('visibilitychange', restart);
		if (adapter === next) {
			withdraw();
			stop();
			adapter = undefined;
			state.set(initial);
		}
	};
}
