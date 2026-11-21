<script lang="ts">
	import { uiText, tr } from '../i18n';
	import { Capacitor } from '@capacitor/core';
	import type { Section } from '../boards/layout';
	import PlayerActionFace from './PlayerActionFace.svelte';
	import {
		Star,
		Heart,
		ListPlus,
		Download,
		CircleCheck,
		Server,
		HardDrive,
		FileAudio,
		Clock3,
		Activity,
		Waves,
		AudioLines,
		Gauge,
		Disc3,
		UserRound,
		UsersRound,
		Tags,
		CalendarDays,
		ListMusic
	} from '@lucide/svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { getJson, postJson, type Session } from '../connection';
	import { trackToolFields } from './layout';
	import type { PlaybackFormat, PlayerTrack } from '../player';
	import { errorMessage, path } from '../catalog/catalog';
	import Cover from '../catalog/Cover.svelte';
	import PlayerQuality from './PlayerQuality.svelte';
	import Favorite from '../catalog/Favorite.svelte';
	import {
		offlineInventory,
		storageSize,
		offlineSupported,
		removeOffline,
		saveOfflineTracks,
		watchOfflineMedia
	} from '../offline/media';
	import type { OfflineOrigin } from '../offline/tracks';
	import { changeTrackFeedback } from '../offline/feedback';
	import {
		feedbackScope,
		feedbackChanged,
		trackFeedback,
		confirmedFeedback,
		type FeedbackRecord
	} from '../offline/feedbackStore';
	import FeedbackStatus from '../offline/FeedbackStatus.svelte';
	import AddToPlaylist from '../catalog/AddToPlaylist.svelte';
	import HomePinButton from '../catalog/HomePinButton.svelte';
	import { trackPin } from '../catalog/homePins';
	import PlaylistDialog from '../catalog/PlaylistDialog.svelte';

	type Model = components['schemas'];
	let {
		session,
		track,
		sample = false,
		section,
		mode = 'field',
		artwork,
		playback,
		duration,
		onsignal,
		fields = trackToolFields.map((a) => a.id) as readonly string[]
	}: {
		session: Session;
		track: PlayerTrack;
		title?: string;
		startOpen?: boolean;
		sample?: boolean;
		section?: Section;
		mode?: 'details' | 'actions' | 'field';
		artwork?: string;
		playback?: PlaybackFormat | null;
		duration?: number;
		onsignal?: () => void;
		fields?: readonly string[];
	} = $props();
	let playlist = $state(false);
	let origin = $state<OfflineOrigin>(),
		deviceReady = $state(false),
		deviceBytes = $state<number>(),
		online = $state(navigator.onLine),
		offlineOnly = $state(false),
		confirmRemove = $state(false),
		changingDownload = $state(false),
		downloadError = $state('');
	let downloadReceipt = $state<{ id: string; text: string }>();
	const backgroundDownloads = Capacitor.isNativePlatform();
	const sourceActions: Record<OfflineOrigin, string> = {
		downloaded: 'Downloaded',
		automatic: 'Keep automatic download',
		cached: 'Keep cached track'
	};
	const downloadLabel = $derived.by(() => {
		if (sample) return 'Save offline';
		if (changingDownload) return 'Updating download…';
		if (origin) return sourceActions[origin];
		if (backgroundDownloads && (!online || offlineOnly)) return 'Queue for download';
		if (!online) return 'Connect to download';
		return offlineOnly ? 'Offline-only playback' : 'Save offline';
	});
	let local = $state<PlayerTrack>(),
		favoriteValue = $state<boolean>(),
		library = $state<Model['TrackView'] | null>(null),
		rating = $state<number | null>(null);
	let libraryError = $state(''),
		ratingError = $state(''),
		saving = $state(false),
		retry = $state(0);
	const trackId = $derived(track.id),
		trackTitle = $derived(track.title);
	const quality = $derived(
		library
			? [
					library.format?.toUpperCase(),
					library.bit_depth && library.bit_depth + '-bit',
					library.sample_rate && library.sample_rate / 1000 + ' kHz',
					library.bit_rate && library.bit_rate + ' kbps'
				]
					.filter(Boolean)
					.join(' · ')
			: (local?.format?.toUpperCase() ?? '')
	);

	const offlineNames: Record<OfflineOrigin, string> = {
		downloaded: 'Saved manually',
		automatic: 'Automatically saved',
		cached: 'Playback cache'
	};
	const offlineState = $derived(
		origin ? offlineNames[origin] : deviceReady ? 'Not saved on this device' : undefined
	);
	function durationLabel(seconds?: number | null) {
		if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return;
		const value = Math.floor(seconds),
			hours = Math.floor(value / 3600);
		const minutes = Math.floor((value % 3600) / 60),
			sec = String(value % 60).padStart(2, '0');
		return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + sec : minutes + ':' + sec;
	}
	function dateLabel(seconds?: number | null) {
		if (!seconds || !Number.isFinite(seconds)) return;
		const date = new Date(seconds * 1000);
		if (Number.isFinite(date.getTime()))
			return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
	}
	const detailGroups = $derived.by(() => {
		if (mode !== 'details') return [];
		const fileBytes = library?.file_size_bytes,
			rate = library?.sample_rate,
			depth = library?.bit_depth,
			bits = library?.bit_rate;
		return [
			{
				title: 'Source',
				rows: [
					{ label: 'Media provider', value: 'DroppedNeedle', icon: Server },
					{ label: 'Offline copy', value: offlineState, icon: Download },
					{
						label: 'File size',
						value: fileBytes && fileBytes > 0 ? storageSize(fileBytes) : undefined,
						icon: FileAudio
					},
					{
						label: 'Size on device',
						value: origin && deviceBytes && deviceBytes > 0 ? storageSize(deviceBytes) : undefined,
						icon: HardDrive
					}
				]
			},
			{
				title: 'Format',
				rows: [
					{
						label: 'Duration',
						value: durationLabel(
							library?.duration_seconds ?? track.duration ?? local?.duration ?? duration
						),
						icon: Clock3
					},
					{
						label: 'Codec or container',
						value: (library?.format || local?.format || track.format)?.toUpperCase(),
						icon: FileAudio
					},
					{ label: 'Bitrate', value: bits && bits > 0 ? bits + ' kbps' : undefined, icon: Gauge },
					{
						label: 'Sample rate',
						value: rate && rate > 0 ? Number((rate / 1000).toFixed(3)) + ' kHz' : undefined,
						icon: Activity
					},
					{
						label: 'Bit depth',
						value: depth && depth > 0 ? depth + '-bit' : undefined,
						icon: Waves
					},
					{
						label: 'Channels',
						value: library?.channels && library.channels > 0 ? library.channels : undefined,
						icon: AudioLines
					}
				]
			},
			{
				title: 'Music metadata',
				rows: [
					{
						label: 'Artist',
						value: library?.artist_name || track.artist || local?.artist,
						icon: UserRound
					},
					{
						label: 'Album',
						value: library?.album_title || track.album || local?.album,
						icon: Disc3
					},
					{
						label: 'Album artist',
						value: library?.album_artist_name || track.albumArtist || local?.albumArtist,
						icon: UsersRound
					},
					{ label: 'Genre', value: library?.genre || track.genre || local?.genre, icon: Tags },
					{ label: 'Year', value: library?.year || track.year || local?.year, icon: CalendarDays },
					{
						label: 'Disc',
						value: library?.disc_number || track.discNumber || local?.discNumber,
						icon: Disc3
					},
					{
						label: 'Track',
						value: library?.track_number || track.trackNumber || local?.trackNumber,
						icon: ListMusic
					},
					{
						label: 'Added to library',
						value: dateLabel(library?.date_added ?? track.dateAdded ?? local?.dateAdded),
						icon: CalendarDays
					}
				]
			}
		]
			.map((group) => ({ ...group, rows: group.rows.filter((row) => row.value) }))
			.filter((group) => group.rows.length);
	});

	$effect(() => {
		if (sample) return;
		const id = trackId,
			name = trackTitle,
			current = session;
		void retry;
		let live = true;
		libraryError = ratingError = downloadError = '';
		rating = null;
		library = null;
		local = undefined;
		favoriteValue = undefined;
		origin = undefined;
		deviceReady = false;
		const scope = feedbackScope(current);
		const wantFavorite = fields.includes('player-favorite'),
			wantRating = fields.includes('player-rating'),
			wantFeedback = wantFavorite || wantRating,
			wantQuality = fields.includes('player-quality') || mode === 'details',
			wantDownload = fields.includes('player-download') && offlineSupported;
		const controller = new AbortController();
		deviceBytes = undefined;
		let observed: FeedbackRecord[] = [];
		async function preferred(field: 'rating' | 'favorite', value: number | boolean) {
			return confirmedFeedback(
				scope,
				id,
				field,
				value,
				observed.find((r) => r.field === field)
			).catch(() => value);
		}
		const update = (event: Event) => {
			const record = (event as CustomEvent<FeedbackRecord>).detail;
			if (record.scope !== scope || record.id !== id) return;
			if (record.field === 'rating') rating = Number(record.value);
			else favoriteValue = record.value === true;
		};
		if (wantFeedback) window.addEventListener(feedbackChanged, update);
		async function findTrack() {
			// The library exposes a paged search. Use the UUID to distinguish live versions and duplicate titles.
			let after: string | undefined;
			const cursors: string[] = [];
			do {
				const result = await getJson<Model['TrackListPage']>(
					current,
					path('/api/v3/library/tracks', {}, { q: name, limit: 100, after }),
					controller.signal
				);
				if (!live) return;
				const found = result.items.find((t) => t.id === id);
				if (found) {
					library = found;
					if (wantFavorite) {
						const favorite = await preferred('favorite', found.favorite);
						if (live) favoriteValue = Boolean(favorite);
					}
					return;
				}
				after = result.next ?? undefined;
				if (!after || cursors.includes(after)) break;
				cursors.push(after);
			} while (live);
			if (live) libraryError = 'Library details are unavailable for this track.';
		}
		let read = 0;
		async function readDevice() {
			const version = ++read;
			const data =
				scope && offlineSupported
					? await offlineInventory(current).catch(() => undefined)
					: undefined;
			if (live && version === read) {
				const saved = data?.byId.get(id);
				origin = saved?.origin;
				deviceBytes = saved?.bytes;
				if (mode === 'details') local = saved?.track;
				offlineOnly = data?.offlineOnly === true;
				deviceReady = mode === 'details' ? !!data : !!scope;
			}
			return data;
		}
		function connectionChanged(event?: Event) {
			online = navigator.onLine;
			if (event?.type === 'online' && mode === 'details') retry++;
		}
		const observeDevice = wantDownload || (mode === 'details' && offlineSupported);
		const stopWatching = observeDevice
			? watchOfflineMedia(() => {
					void readDevice();
				})
			: undefined;
		if (observeDevice) {
			connectionChanged();
			window.addEventListener('online', connectionChanged);
			window.addEventListener('offline', connectionChanged);
		}
		async function load() {
			const data = await readDevice();
			if (!live) return;
			const stored = data?.byId.get(id)?.track;
			if (stored) {
				local = stored;
				favoriteValue = stored.favorite ?? false;
				rating = stored.rating ?? 0;
			}
			const offline = !navigator.onLine || data?.offlineOnly === true;
			if (offline) {
				if (!stored && (wantFavorite || wantRating || (wantQuality && mode !== 'details')))
					libraryError = 'This track has no offline details.';
				return;
			}
			if (stored && wantFeedback) observed = await trackFeedback(scope, id).catch(() => []);
			if (!live) return;
			if (wantQuality || (wantFavorite && !(stored && mode === 'field')))
				void findTrack().catch((e) => {
					if (live && !stored) libraryError = errorMessage(e);
				});
			if (wantRating)
				void postJson<Model['RatingLookupResponse']>(current, path('/api/v3/ratings/lookup'), {
					track_ids: [id]
				})
					.then(async (v) => {
						const confirmed = await preferred('rating', v.tracks[id] ?? 0);
						if (live) rating = Number(confirmed);
					})
					.catch((e) => {
						if (live && !stored) ratingError = errorMessage(e);
					});
		}
		void load();
		return () => {
			live = false;
			controller.abort();
			stopWatching?.();
			window.removeEventListener('online', connectionChanged);
			window.removeEventListener('offline', connectionChanged);
			window.removeEventListener(feedbackChanged, update);
		};
	});
	async function download(remove = false) {
		if (sample || changingDownload) return;
		changingDownload = true;
		downloadError = '';
		downloadReceipt = undefined;
		const id = track.id;
		try {
			if (remove) {
				await removeOffline(session, [track.id]);
				confirmRemove = false;
			} else {
				const result = await saveOfflineTracks(session, [track]);
				if (result.failed) throw Error(result.message);
				if (result.queued && id === track.id) downloadReceipt = { id, text: result.message };
			}
		} catch (error) {
			downloadError = errorMessage(error);
		} finally {
			changingDownload = false;
		}
	}
	async function rate(value: number) {
		if (saving || rating === null) return;
		saving = true;
		ratingError = '';
		try {
			rating = Number(await changeTrackFeedback(session, track.id, 'rating', value));
		} catch (e) {
			ratingError = errorMessage(e);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet heart(active: boolean)}<PlayerActionFace
		section={mode === 'field' ? section : undefined}
		glyph={Heart}
		size={18}
		label={active ? 'Favorited' : 'Favorite'}
		fill={active}
		defaultLabel={mode === 'actions'}
	/>{/snippet}
{#snippet favorite()}{#if sample}<button
			class="icon-button player-control"
			aria-label={uiText('Favorite track')}>{@render heart(false)}</button
		>
	{:else if favoriteValue !== undefined}<Favorite
			{session}
			kind="track"
			id={track.id}
			value={favoriteValue}
			face={heart}
		/>
	{:else if !libraryError}<button
			class="icon-button player-control"
			disabled
			aria-label={uiText('Loading favorite')}>{@render heart(false)}</button
		>{/if}{/snippet}
{#snippet addPlaylist()}<button
		class="secondary player-control"
		aria-label={uiText('Add to playlist')}
		onclick={() => {
			if (!sample) playlist = true;
		}}
	>
		<PlayerActionFace
			section={mode === 'field' ? section : undefined}
			glyph={ListPlus}
			size={17}
			label={uiText('Add to playlist')}
			defaultLabel
		/>
	</button>{/snippet}
{#snippet contents()}
	{#if fields.includes('player-favorite') || fields.includes('player-playlist') || (fields.includes('player-download') && offlineSupported)}<div
			class="tools"
			class:action-list={mode === 'actions'}
		>
			{#if fields.includes('player-favorite')}{@render favorite()}{/if}{#if fields.includes('player-playlist')}{@render addPlaylist()}{/if}
			{#if fields.includes('player-download') && offlineSupported}<button
					class="secondary player-control"
					aria-label={origin === 'downloaded' ? 'Manage track download' : downloadLabel}
					title={downloadLabel}
					disabled={!sample &&
						(!deviceReady ||
							changingDownload ||
							(!backgroundDownloads && !origin && (!online || offlineOnly)))}
					onclick={() => {
						if (origin === 'downloaded') confirmRemove = true;
						else void download();
					}}
					><PlayerActionFace
						section={mode === 'field' ? section : undefined}
						glyph={origin === 'downloaded' ? CircleCheck : Download}
						size={18}
						label={downloadLabel}
						defaultLabel
					/></button
				>{/if}
		</div>{/if}
	{#if downloadError && !confirmRemove}<p role="alert">{downloadError}</p>{/if}
	{#if downloadReceipt?.id === track.id && !origin}
		<p role="status">
			{downloadReceipt.text}
			<button class="text-button" onclick={() => window.dispatchEvent(new Event('dn-open-offline'))}
				>{uiText('View download queue')}</button
			>
		</p>
	{/if}
	{#if fields.includes('player-rating') && (rating !== null || sample)}<div
			class="stars"
			role="group"
			aria-label={uiText('Your track rating')}
		>
			{#each [1, 2, 3, 4, 5] as value (value)}
				<button
					disabled={saving}
					aria-label={'Rate ' + value + (value === 1 ? ' star' : ' stars')}
					aria-pressed={rating === value}
					onclick={() => rate(rating === value ? 0 : value)}
					><PlayerActionFace
						section={mode === 'field' && section ? { ...section, showLabel: false } : undefined}
						glyph={Star}
						size={20}
						label={String(value)}
						fill={(sample ? 3 : (rating ?? 0)) >= value}
					/></button
				>
			{/each}
		</div>{/if}
	{#if mode !== 'details' && fields.includes('player-quality') && (quality || sample)}<p>
			{sample ? 'FLAC · 24-bit · 48 kHz' : quality}
		</p>{/if}
	{#if !sample && local && (fields.includes('player-favorite') || fields.includes('player-rating'))}
		<FeedbackStatus
			{session}
			id={track.id}
			field={fields.length === 1
				? fields[0] === 'player-rating'
					? 'rating'
					: 'favorite'
				: undefined}
		/>
	{/if}
	{#if libraryError || ratingError}<p role="alert">
			{[libraryError, ratingError].filter(Boolean).join(' ')}
		</p>
		<button class="text-button" onclick={() => retry++}>{uiText('Try again')}</button
		>{/if}{/snippet}
{#if mode === 'actions' && !sample}<HomePinButton {session} pin={trackPin(track)} compact />{/if}
{#if mode === 'details'}
	<div class="details" data-part="track-details">
		<header class="details-title">
			<span class="thumbnail"
				><Cover
					{session}
					path={artwork}
					seed={track.album || track.id}
					cacheOnly={offlineOnly || !online}
				/></span
			>
			<h2>{track.title}</h2>
		</header>
		{#each detailGroups as group (group.title)}
			<section aria-label={uiText(group.title)}>
				<h3>{uiText(group.title)}</h3>
				<dl>
					{#each group.rows as row (row.label)}
						<div class="detail-row">
							<dt><row.icon size={20} aria-hidden="true" />{uiText(row.label)}</dt>
							<dd>{row.value}</dd>
						</div>
					{/each}
				</dl>
			</section>
		{/each}
		{#if playback?.format}<section aria-label={uiText('Current playback')}>
				<h3>{uiText('Current playback')}</h3>
				{#if onsignal}<button
						class="playing-format"
						aria-label={tr('Open signal path', '信号経路を開く')}
						onclick={onsignal}><PlayerQuality {track} quality={playback} /></button
					>
				{:else}<div class="playing-format"><PlayerQuality {track} quality={playback} /></div>{/if}
			</section>{/if}
	</div>
{/if}
{@render contents()}
{#if playlist}<AddToPlaylist {session} tracks={[track]} onclose={() => (playlist = false)} />{/if}
{#if confirmRemove}<PlaylistDialog
		title={uiText('Remove download?')}
		busy={changingDownload}
		onclose={() => (confirmRemove = false)}
	>
		<p>{uiText('Remove the saved copy of “')}{track.title}{uiText('” from this device?')}</p>
		{#if downloadError}<p role="alert">{downloadError}</p>{/if}
		<div class="actions">
			<button class="secondary" disabled={changingDownload} onclick={() => (confirmRemove = false)}
				>{uiText('Keep download')}</button
			>
			<button class="primary" disabled={changingDownload} onclick={() => void download(true)}
				>{uiText('Remove download')}</button
			>
		</div>
	</PlaylistDialog>{/if}

<style>
	.details {
		min-width: 0;
	}
	.details-title {
		display: flex;
		gap: 0.95rem;
		align-items: center;
		margin: 0.25rem 0 1.15rem;
	}
	.thumbnail {
		width: clamp(3.25rem, 15vw, 4.25rem);
		flex: none;
	}
	.details-title h2 {
		margin: 0;
		font-size: 1.3rem;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}
	.details h3 {
		margin: 0.95rem 0 0.35rem;
		color: var(--accent);
		font-size: 1rem;
		font-weight: 650;
	}
	.details dl {
		margin: 0;
	}
	.detail-row {
		display: grid;
		grid-template-columns: 1.4rem minmax(0, 1fr);
		column-gap: 0.8rem;
		row-gap: 0.1rem;
		padding: 0.48rem 0.2rem;
		align-content: center;
	}
	.detail-row dt {
		display: flex;
		gap: 0.8rem;
		grid-column: 1/-1;
		align-items: center;
		font-size: 0.85rem;
		line-height: 1.25;
		color: var(--muted);
	}
	.detail-row dt :global(svg) {
		color: var(--text);
		flex: none;
		width: 1.4rem;
	}
	.detail-row dd {
		grid-column: 2;
		margin: 0;
		color: var(--text);
		font-size: 1rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}
	.playing-format {
		padding: 0.5rem 0.2rem;
	}
	.playing-format :global(.quality) {
		font-size: 0.97rem;
		color: var(--text);
		gap: 0.8rem;
	}
	button.player-control {
		width: auto;
		min-width: min(44px, 100%);
		height: auto;
		min-height: 44px;
		max-width: 100%;
	}

	.stars,
	.tools,
	.tools .secondary {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		justify-content: var(--cell-justify, flex-start);
		gap: 0.35rem;
	}
	.tools.action-list {
		display: grid;
		gap: 0;
		justify-content: stretch;
	}
	.action-list :global(button) {
		display: flex;
		align-items: center;
		justify-content: start;
		width: 100%;
		padding: 0;
		background: none;
		border: 0;
		border-radius: 0;
	}
	.action-list :global(.face) {
		flex-direction: row;
		gap: 0.8rem;
	}
	.action-list :global(.glyph) {
		flex: none;
		width: 20px;
	}
	.stars button {
		min-height: 44px;
		min-width: 44px;
		color: var(--accent);
	}
	p {
		color: var(--muted);
	}
</style>
