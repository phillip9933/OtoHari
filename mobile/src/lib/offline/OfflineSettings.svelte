<script lang="ts">
	import { tr, uiText, uiFormat } from '../i18n';

	import InlineChoice from '../controls/InlineChoice.svelte';
	import AndroidCacheSettings from './AndroidCacheSettings.svelte';
	import { onMount } from 'svelte';
	import { online } from 'svelte/reactivity/window';
	import { rememberedPlaylistNames } from '../catalog/playlistOffline';
	import { playlists } from '../catalog/playlists';
	import { playlistId, playlistSource, type PlaylistSource } from './tracks';
	import { Capacitor } from '@capacitor/core';
	import type { Session } from '../connection';
	import ViewedMediaSettings from './ViewedMediaSettings.svelte';
	import AndroidHistorySettings from './AndroidHistorySettings.svelte';
	import DownloadNotifications from './DownloadNotifications.svelte';
	import OfflineCollections from './OfflineCollections.svelte';
	import { conversionState, original, rates, type Format } from '../player/streaming';
	import {
		cacheSizes,
		clearAutomatic,
		clearPlaylistDownloads,
		playlistSyncIssue,
		configureOffline,
		nativeOffline,
		offlineDefaults,
		offlineSnapshot,
		runAutoDownloads,
		watchOfflineMedia,
		storageSize,
		type OfflineOptions
	} from './media';
	let { session }: { session: Session } = $props();
	let options = $state<OfflineOptions>({ ...offlineDefaults }),
		saved = $state(0),
		cached = $state(0),
		automatic = $state(0),
		loading = $state(true),
		busy = $state(false),
		syncing = $state(false),
		confirming = $state(false),
		error = $state(''),
		receipt = $state('');
	let picking = $state(false),
		confirmPlaylist = $state(false),
		playlistError = $state(''),
		syncIssue = $state(''),
		listRetry = $state(0),
		listLoading = $state(false);
	let choices = $state.raw<{ id: string; name: string }[]>([]);
	const quality = $derived(options.downloadQuality ?? original);
	const hasPins = $derived((options.offlinePins?.length ?? 0) > 0);
	const selectedId = $derived(playlistId(options.autoDownload));
	const showPicker = $derived(picking || selectedId !== null);
	const useNetwork = $derived(!options.offlineOnly && online.current);
	let conversion = $state<'on' | 'off' | 'unavailable'>();
	$effect(() => {
		const owner = session;
		if (!nativeOffline || !useNetwork) {
			conversion = undefined;
			return;
		}
		let current = true;
		void conversionState(owner)
			.then((value) => {
				if (current) conversion = value.conversion;
			})
			.catch(() => {
				if (current) conversion = undefined;
			});
		return () => {
			current = false;
		};
	});
	const canSelect = (p: { id: string }) =>
		playlistSource(p.id) !== null && !p.id.includes('/') && !p.id.includes('\\');
	$effect(() => {
		const source = options.autoDownload,
			owner = session;
		const update = () => (syncIssue = playlistSyncIssue(owner, source));
		update();
		window.addEventListener('dn-playlist-sync', update);
		return () => window.removeEventListener('dn-playlist-sync', update);
	});
	$effect(() => {
		if (!showPicker) return;
		const controller = new AbortController(),
			owner = session;
		void listRetry;
		choices = rememberedPlaylistNames(owner).filter(canSelect);
		playlistError = '';
		listLoading = !!useNetwork;
		if (useNetwork)
			playlists(owner, controller.signal)
				.then((rows) => {
					if (!controller.signal.aborted) choices = rows.filter(canSelect);
				})
				.catch(() => {
					if (!controller.signal.aborted) playlistError = 'Could not refresh the playlist list.';
				})
				.finally(() => {
					if (!controller.signal.aborted) listLoading = false;
				});
		return () => controller.abort();
	});
	async function clearPlaylist() {
		if (!selectedId || busy) return;
		busy = true;
		++syncVisit;
		syncing = false;
		error = '';
		confirmPlaylist = false;
		try {
			options = await clearPlaylistDownloads(session, options.autoDownload as PlaylistSource);
			picking = false;
			await read();
			receipt = 'Automatic downloads turned off and automatic copies removed.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not remove automatic copies.';
		} finally {
			busy = false;
		}
	}
	function chooseSource(value: string) {
		confirmPlaylist = false;
		picking = value === 'playlist';
		if (value === 'recent' || value === 'favorites' || value === 'off')
			void change({ ...options, autoDownload: value });
	}
	async function read() {
		try {
			const state = await offlineSnapshot(session);
			options = state.options;
			const bytes = (origin: 'downloaded' | 'automatic' | 'cached') =>
				state.items.reduce((n, i) => n + (i.origin === origin ? i.bytes : 0), 0);
			saved = bytes('downloaded');
			cached = bytes('cached');
			automatic = bytes('automatic');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not read offline storage.';
		} finally {
			loading = false;
		}
	}
	async function change(next: OfflineOptions, clearUnpinned = false) {
		if (busy) return;
		busy = true;
		++syncVisit;
		syncing = false;
		confirmPlaylist = false;
		error = '';
		receipt = '';
		try {
			const changedSource =
				options.autoDownload !== next.autoDownload ||
				JSON.stringify(options.offlinePins) !== JSON.stringify(next.offlinePins) ||
				options.downloadMiB !== next.downloadMiB ||
				(options.offlineOnly && !next.offlineOnly) ||
				(options.unmeteredOnly && !next.unmeteredOnly);
			await configureOffline(session, next, clearUnpinned);
			await read();
			busy = false;
			if (
				changedSource &&
				(next.autoDownload !== 'off' || next.offlinePins?.length) &&
				!next.offlineOnly
			)
				await sync();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save this setting.';
		} finally {
			busy = false;
		}
	}
	let syncVisit = 0;
	async function sync() {
		const visit = ++syncVisit;
		syncing = true;
		error = '';
		receipt = '';
		try {
			if (!navigator.onLine) throw Error('Reconnect to update automatic downloads.');
			const n = await runAutoDownloads(session);
			if (visit !== syncVisit) return;
			receipt = n
				? n + (n === 1 ? ' automatic download added.' : ' automatic downloads added.')
				: 'No automatic downloads added.';
		} catch (e) {
			if (
				visit === syncVisit &&
				!(e instanceof Error && playlistSyncIssue(session, options.autoDownload) === e.message) &&
				!(e instanceof DOMException && e.name === 'AbortError')
			)
				error = e instanceof Error ? e.message : 'Could not update automatic downloads.';
		} finally {
			if (visit === syncVisit) syncing = false;
		}
	}
	async function clear() {
		busy = true;
		confirming = false;
		try {
			await clearAutomatic(session);
			await read();
			receipt = 'Playback cache cleared.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not clear the playback cache.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		void read();
		return watchOfflineMedia(read);
	});
</script>

{#if loading}<p role="status">{uiText('Reading device storage…')}</p>
{:else}
	<h2 id="offline-playback">{uiText('Playback')}</h2>
	<fieldset
		class="settings-panel"
		data-surface="panel"
		aria-labelledby="offline-playback"
		disabled={busy}
	>
		<label
			><input
				type="checkbox"
				checked={options.offlineOnly}
				onchange={(e) => change({ ...options, offlineOnly: e.currentTarget.checked })}
			/>{uiText('Play only offline music')}</label
		>
		<label
			><input
				type="checkbox"
				checked={options.autoCache}
				onchange={(e) => change({ ...options, autoCache: e.currentTarget.checked })}
			/>{uiText('Cache songs during playback')}</label
		>
		<p>
			{uiText(
				'Completed streams stay available offline. Older cached songs are removed when the cache fills.'
			)}
		</p>
		<label
			>{uiText('Playback cache limit')}<InlineChoice selected={options.cacheMiB}
				><select
					value={options.cacheMiB}
					onchange={(e) => change({ ...options, cacheMiB: Number(e.currentTarget.value) })}
					>{#each cacheSizes as size (size)}<option value={size}
							>{size >= 1024 ? size / 1024 + ' GiB' : size + ' MiB'}</option
						>{/each}</select
				></InlineChoice
			></label
		>
		{#if nativeOffline}<label
				><input
					type="checkbox"
					checked={options.unmeteredOnly}
					onchange={(e) => change({ ...options, unmeteredOnly: e.currentTarget.checked })}
				/>{tr(
					'Use only unmetered networks for downloads and played-song caching',
					'ダウンロードと再生済み曲のキャッシュには非従量制回線のみを使用'
				)}</label
			>{/if}
	</fieldset>
	{#if nativeOffline}
		<AndroidCacheSettings {session} {options} {change} {busy} />
		<h2 id="download-quality">{uiText('Download quality')}</h2>
		<fieldset
			class="settings-panel"
			data-surface="panel"
			aria-labelledby="download-quality"
			disabled={busy}
		>
			<label
				>{uiText('File format')}<InlineChoice selected={quality.format}
					><select
						value={quality.format}
						onchange={(e) =>
							change({
								...options,
								downloadQuality: { ...quality, format: e.currentTarget.value as Format }
							})}
					>
						<option value="original">{uiText('Original file')}</option><option value="mp3"
							>MP3</option
						><option value="opus">Opus</option>
					</select></InlineChoice
				></label
			>
			{#if quality.format !== 'original'}<label
					>{uiText('Download bitrate')}<InlineChoice selected={quality.rate}
						><select
							value={quality.rate}
							onchange={(e) =>
								change({
									...options,
									downloadQuality: { ...quality, rate: Number(e.currentTarget.value) }
								})}
						>
							{#each rates as rate (rate)}<option value={rate}>{rate} kbps</option>{/each}
						</select></InlineChoice
					></label
				>{/if}
			<p>
				{uiText('Applies to new manual and automatic downloads.')}
				{#if conversion === 'off'}{uiText(
						'This DN server has conversion turned off. Downloads use the original file.'
					)}
				{:else if conversion === 'unavailable'}{uiText(
						'This DN server reports that ffmpeg is unavailable. Downloads use the original file.'
					)}
				{:else}{uiText('DN serves the original file when conversion is unavailable.')}{/if}
			</p>
		</fieldset>
	{/if}
	<h2 id="auto-download-options">{uiText('Automatic downloads')}</h2>
	<fieldset
		class="settings-panel"
		data-surface="panel"
		aria-labelledby="auto-download-options"
		disabled={busy}
	>
		{#if nativeOffline}
			<OfflineCollections
				{options}
				{session}
				online={!!useNetwork}
				onpins={(pins) => change({ ...options, autoDownload: 'off', offlinePins: pins }, true)}
			/>
			{#if syncIssue}<p role="status">{syncIssue}</p>{/if}
		{:else}
			<label
				>{uiText('Download source')}<InlineChoice
					selected={showPicker ? 'playlist' : options.autoDownload}
					><select
						value={showPicker ? 'playlist' : options.autoDownload}
						onchange={(e) => chooseSource(e.currentTarget.value)}
					>
						<option value="off">{uiText('Off')}</option>
						<option value="recent">{uiText('Recently added songs')}</option>
						<option value="favorites">{uiText('Favorite songs')}</option>
						<option value="playlist">{uiText('DN playlist')}</option>
					</select></InlineChoice
				></label
			>
			{#if showPicker}
				<label
					>{uiText('DN playlist')}<InlineChoice selected={selectedId ?? ''}
						><select
							value={selectedId ?? ''}
							onchange={(e) => {
								const source = playlistSource(e.currentTarget.value);
								if (source) void change({ ...options, autoDownload: source });
							}}
						>
							<option value="" disabled>{uiText('Choose a playlist')}</option>
							{#if selectedId && !choices.some((p) => p.id === selectedId)}<option
									value={selectedId}>{uiText('Selected playlist')}</option
								>{/if}
							{#each choices as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
						</select></InlineChoice
					></label
				>
				{#if playlistError}<p role="status">{playlistError}</p>
					<button class="text-button" onclick={() => listRetry++}
						>{uiText('Refresh playlist list')}</button
					>
				{:else if listLoading}<p role="status">{uiText('Reading playlists…')}</p>
				{:else if !choices.length}<p>
						{useNetwork
							? uiText('No DN playlists available.')
							: uiText('Reconnect to DN to choose a playlist.')}
					</p>{/if}
				{#if selectedId}
					{#if syncIssue}<p role="status">{syncIssue}</p>{/if}
					{#if confirmPlaylist}<p>
							{uiText(
								'Turn off automatic downloads and remove all automatic copies for this account? Manually saved songs and the playback cache will stay.'
							)}
						</p>
						<button class="secondary" onclick={() => (confirmPlaylist = false)}
							>{uiText('Cancel')}</button
						>
						<button class="secondary" onclick={clearPlaylist}
							>{uiText('Turn off and remove automatic copies')}</button
						>
					{:else}<button class="text-button" onclick={() => (confirmPlaylist = true)}
							>{uiText('Remove automatic playlist downloads')}</button
						>{/if}
				{/if}
			{/if}
		{/if}
		{#if options.autoDownload !== 'off' || hasPins}
			{#if !nativeOffline}<p>
					{selectedId
						? uiText(
								'Keep playable songs in playlist order within your download limit. The app checks DN when you return.'
							)
						: uiText(
								'Keep up to 25 of the most recently added songs from this source while the app is open.'
							)}
					{uiText('Songs you remove stay excluded until you save them yourself.')}
				</p>{/if}
			<label
				>{uiText('Automatic download limit')}<InlineChoice selected={options.downloadMiB}
					><select
						value={options.downloadMiB}
						onchange={(e) => change({ ...options, downloadMiB: Number(e.currentTarget.value) })}
					>
						{#each cacheSizes as size (size)}<option value={size}
								>{size >= 1024 ? size / 1024 + ' GiB' : size + ' MiB'}</option
							>{/each}
					</select></InlineChoice
				></label
			>
			<button class="secondary" disabled={options.offlineOnly || syncing} onclick={sync}
				>{uiText('Update automatic downloads')}</button
			>
		{/if}
	</fieldset>
	{#if nativeOffline}
		<h2 id="download-notifications">{uiText('Download notifications')}</h2>
		<fieldset class="settings-panel" data-surface="panel" aria-labelledby="download-notifications">
			{#if Capacitor.getPlatform() === 'ios'}
				<label
					><input
						type="checkbox"
						checked={options.notifyDownloads === true}
						onchange={(e) => change({ ...options, notifyDownloads: e.currentTarget.checked })}
					/>{tr(
						'Notify when a download batch finishes',
						'ダウンロードキューの完了時に通知する'
					)}</label
				>
			{/if}
			<DownloadNotifications />
		</fieldset>
	{/if}
	{#if nativeOffline && session.userId}<AndroidHistorySettings {session} />{/if}
	<ViewedMediaSettings {session} kind="artwork" />
	<ViewedMediaSettings {session} kind="lyrics" />
	<h2>{uiText('On this device')}</h2>
	<dl class="settings-facts" data-surface="panel">
		<div>
			<dt>{uiText('Saved downloads')}</dt>
			<dd>{storageSize(saved)}</dd>
		</div>
		<div>
			<dt>{uiText('Automatic downloads')}</dt>
			<dd>{storageSize(automatic)}</dd>
		</div>
		<div>
			<dt>{uiText('Playback cache')}</dt>
			<dd>{storageSize(cached)}</dd>
		</div>
	</dl>
	<div class="settings-actions">
		<button
			class="secondary"
			disabled={busy}
			onclick={() => window.dispatchEvent(new Event('dn-open-offline'))}
			>{uiText('Open offline music')}</button
		>
		{#if confirming}<p>
				{uiFormat('Clear {size} of cached music? Saved downloads will stay on this device.', {
					size: storageSize(cached)
				})}
			</p>
			<button class="secondary" onclick={() => (confirming = false)}>{uiText('Cancel')}</button
			><button class="primary" onclick={clear}>{uiText('Confirm clear cache')}</button>
		{:else}<button
				class="text-button"
				disabled={busy || !cached}
				onclick={() => (confirming = true)}>{uiText('Clear playback cache')}</button
			>{/if}
	</div>
{/if}
{#if error}<p role="alert">{error}</p>
	<button
		class="text-button"
		onclick={() => {
			error = '';
			void read();
		}}>{uiText('Try again')}</button
	>{/if}
{#if receipt}<p role="status">{receipt}</p>{/if}
