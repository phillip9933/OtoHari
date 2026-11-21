import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import type { Session } from '../connection';

import { nativePlayer } from './native';

export function widgetLinks(account: () => Session | null | undefined, showPlayer: () => void) {
	let pending = '';
	let stopped = false;
	async function consume() {
		const current = account();
		if (!current?.userId || !pending || stopped) return;
		const url = pending;
		pending = '';
		const result = await nativePlayer.widgetAction({
			url,
			serverUrl: current.serverUrl,
			userId: current.userId
		});
		if (!stopped && result.opened && account() === current) showPlayer();
	}
	function receive(url?: string) {
		if (!url || stopped || !/^[a-z0-9.-]+\.widgets:\/\/player\//i.test(url)) return;
		pending = url;
		void consume().catch(() => {});
	}
	if (Capacitor.getPlatform() !== 'ios') return { consume, stop() {} };
	let received = false;
	const handle = App.addListener('appUrlOpen', ({ url }) => {
		received = true;
		receive(url);
	});
	void handle
		.then(() => App.getLaunchUrl())
		.then((launch) => {
			if (!received) receive(launch?.url);
		})
		.catch(() => {});
	return {
		consume,
		stop() {
			stopped = true;
			void handle.then((event) => event.remove()).catch(() => {});
		}
	};
}
