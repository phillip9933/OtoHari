import { Capacitor, registerPlugin } from '@capacitor/core';
import { writable } from 'svelte/store';
import type { Session } from '../connection';
import { tr } from '../i18n';
import {
	collectionKey,
	readHome,
	watchHome,
	pinKey,
	type HomePin,
	type HomeCollection
} from './homePins';
import { mixRequest } from './mixBuilder';
import { onPlaylistMembership, rememberedPlaylistTrackIds } from './playlistOffline';
import { accountId } from '../boards/layout';

type Account = Pick<Session, 'serverUrl' | 'userId'>;
const native = registerPlugin<{
	takePlayerNotification(): Promise<{ open: boolean }>;
	pinPlaylist(options: Account & { id: string; name: string; remove?: boolean }): Promise<void>;
	playlistPinned(options: Account & { id: string }): Promise<{ pinned: boolean }>;
	takePlaylist(options: Account): Promise<{ id?: string }>;
	clearShortcuts(options: Account): Promise<void>;
	replaceHomePins(options: Account & { pins: unknown[] }): Promise<void>;
}>('DNLauncher');
const platform = Capacitor.getPlatform();
export const launcherShortcuts = platform === 'android' || platform === 'ios';
export function playlistShortcutLabel(pinned: boolean) {
	if (pinned)
		return tr('Remove Home Screen quick action', 'ホーム画面のクイックアクションから削除');
	return platform === 'ios'
		? tr('Add Home Screen quick action', 'ホーム画面のクイックアクションに追加')
		: tr('Add Android launcher shortcut', 'Androidのホーム画面にショートカットを追加');
}
export function playlistShortcutReceipt(removed: boolean) {
	if (removed)
		return tr(
			'Home Screen quick action removed.',
			'ホーム画面のクイックアクションから削除しました。'
		);
	return platform === 'ios'
		? tr(
				'Touch and hold DroppedNeedle on the Home Screen to open this playlist.',
				'ホーム画面でDroppedNeedleを長押しすると、このプレイリストを開けます。'
			)
		: tr(
				'Confirm the playlist shortcut in your launcher.',
				'Androidのホーム画面でショートカットの追加を確定してください。'
			);
}
export const pendingShortcut = writable<{ session: Session; id: string } | null>(null);
export async function isPlaylistPinned(session: Session, id: string) {
	if (platform !== 'ios') return false;
	return (await native.playlistPinned({ serverUrl: session.serverUrl, userId: session.userId, id }))
		.pinned;
}
export function takePlayerNotification() {
	return native.takePlayerNotification();
}
export function pinPlaylist(session: Session, id: string, name: string, remove = false) {
	return native.pinPlaylist({
		serverUrl: session.serverUrl,
		userId: session.userId,
		id,
		name,
		...(remove ? { remove } : {})
	});
}
export async function clearIPhonePlaylistShortcuts(session: Session) {
	if (platform === 'ios' && session.userId)
		await native.clearShortcuts({ serverUrl: session.serverUrl, userId: session.userId });
}
export function takePlaylistShortcut(session: Session) {
	return native.takePlaylist({ serverUrl: session.serverUrl, userId: session.userId });
}
function carPin(session: Session, pin: HomePin, data: HomeCollection) {
	const mix = pin.kind === 'mix' ? data.mixes.find((m) => m.id === pin.id) : undefined;
	return {
		kind: pin.kind,
		id: pin.id,
		title: pin.title,
		artist: pin.artist,
		album: pin.album,
		localId: pin.localId,
		mbid: pin.mbid,
		stationType: pin.stationType,
		songs: data.lastTracks[pinKey(pin)],
		playlistIds: pin.kind === 'playlist' ? rememberedPlaylistTrackIds(session, pin.id) : undefined,
		plan: mix
			? mixRequest(mix)
			: pin.kind === 'station'
				? { seed_type: pin.stationType, seed_id: pin.id }
				: undefined
	};
}
export function mirrorHomePins(session: Session) {
	if (platform !== 'android') return;
	let live = true,
		stop: (() => void) | undefined,
		pending = Promise.resolve();
	void accountId(session)
		.then((userId) => {
			if (!live) return;
			const key = collectionKey(session.serverUrl, userId);
			const publish = (data: HomeCollection) => {
				const pins = data.pins
					.filter((p) => p.kind !== 'smart')
					.map((p) => carPin(session, p, data));
				pending = pending
					.then(async () => {
						if (live) await native.replaceHomePins({ serverUrl: session.serverUrl, userId, pins });
					})
					.catch(() => {
						/* Older Android builds still use the in-app pins. */
					});
			};
			const stopPins = watchHome(key, publish),
				stopMembership = onPlaylistMembership(session, () => publish(readHome(key)));
			stop = () => {
				stopPins();
				stopMembership();
			};
		})
		.catch(() => {});
	return () => {
		live = false;
		stop?.();
	};
}
