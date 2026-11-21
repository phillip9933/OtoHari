<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { tr, uiText } from '../i18n';
	import { App } from '@capacitor/app';
	import { onMount } from 'svelte';
	import { nativeMedia, type DownloadNotificationState } from './nativeMedia';

	const iphone = Capacitor.getPlatform() === 'ios';
	const statuses = {
		undecided: 'Notification permission has not been requested.',
		appOff: 'Off for DroppedNeedle.',
		appOn: 'On for DroppedNeedle. The download channel appears after your first download starts.',
		channelOff: 'Off for offline downloads.',
		on: 'On for offline downloads.'
	};
	let permission = $state<DownloadNotificationState>(),
		failed = $state(false),
		opening = $state(false),
		error = $state('');
	let revision = 0;
	const label = $derived(
		iphone
			? permission === 'undecided'
				? tr('Allow iPhone notifications', 'iPhoneの通知を許可')
				: tr('Open iPhone notification settings', 'iPhoneの通知設定を開く')
			: uiText('Open Android notification settings')
	);
	const status = $derived.by(() => {
		if (failed)
			return iphone
				? tr(
						'Could not read iPhone notification settings.',
						'iPhoneの通知設定を読み込めませんでした。'
					)
				: uiText('Could not read Android notification settings.');
		if (!permission)
			return iphone
				? tr('Checking notification settings…', '通知設定を確認中…')
				: uiText('Checking Android notification settings…');
		if (!iphone) return uiText(statuses[permission]);
		if (permission === 'undecided')
			return tr(
				'iPhone notification permission has not been requested.',
				'iPhoneの通知はまだ許可されていません。'
			);
		if (permission === 'on')
			return tr(
				'Notifications are allowed on this iPhone.',
				'このiPhoneの通知は許可されています。'
			);
		return tr('Notifications are off in iOS Settings.', 'iOSの設定で通知がオフになっています。');
	});

	async function refresh() {
		const request = ++revision;
		try {
			const result = await nativeMedia.downloadNotificationSettings();
			if (request === revision) {
				permission = result.state;
				failed = false;
			}
		} catch {
			if (request === revision) failed = true;
		}
	}

	onMount(() => {
		const resumed = App.addListener('resume', refresh);
		void refresh();
		return () => {
			revision++;
			void resumed.then((listener) => listener.remove()).catch(() => {});
		};
	});

	async function open() {
		opening = true;
		error = '';
		try {
			await nativeMedia.openDownloadNotificationSettings();
			if (iphone) await refresh();
		} catch {
			error = iphone
				? tr('Could not open iPhone notification settings.', 'iPhoneの通知設定を開けませんでした。')
				: uiText('Could not open Android notification settings.');
		} finally {
			opening = false;
		}
	}
</script>

<p role="status">{status}</p>
<button class="secondary" disabled={opening} onclick={open}>{label}</button>
{#if error}<p role="alert">{error}</p>{/if}

<style>
	p {
		color: var(--muted);
		margin: 0;
		line-height: 1.45;
	}
</style>
