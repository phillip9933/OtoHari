<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Pin,
		ListMusic,
		Disc3,
		Music2,
		Radio,
		UsersRound,
		Tags,
		ChevronUp,
		ChevronDown,
		X,
		SlidersHorizontal
	} from '@lucide/svelte';
	import { tr } from '../i18n';
	import type { Session } from '../connection';
	import type { PlayerTrack } from '../player';
	import { offlineInventory } from '../offline/media';
	import { availableTracks } from '../offline/library';
	import { type Album, type OnPlay, errorMessage } from '../catalog/catalog';
	import { libraryRadio, type DiscoverArtistRef } from '../catalog/discovery';
	import { playlistArtwork, playlists, type Playlist } from '../catalog/playlists';
	import { rememberedPlaylistCovers } from '../catalog/playlistOffline';
	import { readSmartPlaylists, smartPlaylistTracks } from '../catalog/smartPlaylists';
	import { beginPlaybackPreparation } from '../catalog/browseActions';
	import { playMix } from '../catalog/mixBuilder';
	import {
		collectionKey,
		readHome,
		watchHome,
		pinKey,
		pinTrack,
		devicePinTracks,
		setPinned,
		movePin,
		rememberPlan,
		pinKindLabel,
		type HomePin,
		type HomeCollection
	} from '../catalog/homePins';
	import PlaylistCover from '../catalog/PlaylistCover.svelte';
	import Cover from '../catalog/Cover.svelte';
	let {
		session,
		owner,
		active,
		offline,
		available,
		onopen,
		onartist,
		onlocal,
		onplaylist,
		ongenre,
		onplay,
		onnetworkerror
	}: {
		session: Session;
		owner: string;
		active: boolean;
		offline: boolean;
		available?: PlayerTrack[];
		onopen: (album: Album) => void;
		onartist: (a: DiscoverArtistRef) => void;
		onlocal: (a: { id: string; name: string }) => void;
		onplaylist: (p: Playlist) => void;
		ongenre?: (name: string) => void;
		onplay: OnPlay;
		onnetworkerror: (cause: unknown) => boolean;
	} = $props();
	const key = $derived(collectionKey(session.serverUrl, owner));
	const icons = {
		track: Music2,
		artist: UsersRound,
		album: Disc3,
		genre: Tags,
		playlist: ListMusic,
		smart: ListMusic,
		mix: ListMusic,
		station: Radio
	};
	let store = $state.raw<HomeCollection>(),
		arranging = $state(false),
		status = $state(''),
		busy = $state(''),
		job: AbortController | undefined;
	$effect(() =>
		watchHome(key, (data) => {
			store = data;
			if (!data.pins.length) arranging = false;
		})
	);
	$effect(() => {
		void session;
		void offline;
		if (!active) job?.abort();
		return () => job?.abort();
	});
	const hasPlaylistPins = $derived(store?.pins.some((pin) => pin.kind === 'playlist'));
	let playlistCovers = $state.raw(new Map<string, string[]>());
	$effect(() => {
		if (!active || !hasPlaylistPins) return;
		const account = session;
		playlistCovers = rememberedPlaylistCovers(account);
		if (offline) return;
		let request: AbortController;
		function refresh() {
			request?.abort();
			const job = new AbortController();
			request = job;
			void playlists(account, job.signal).then(
				(items) => {
					if (!job.signal.aborted)
						playlistCovers = new Map(items.map((p) => [p.id, playlistArtwork(p)]));
				},
				() => {
					/* Keep the last artwork when DN is unavailable. */
				}
			);
		}
		refresh();
		window.addEventListener('dn-playlists-updated', refresh);
		return () => {
			request.abort();
			window.removeEventListener('dn-playlists-updated', refresh);
		};
	});
	onDestroy(() => job?.abort());
	function rearrange(run: () => void) {
		try {
			run();
			status = '';
		} catch (e) {
			status = errorMessage(e);
		}
	}
	async function open(pin: HomePin) {
		job?.abort();
		job = new AbortController();
		const request = job,
			signal = request.signal,
			finish = beginPlaybackPreparation(() => request.abort());
		busy = pinKey(pin);
		status = '';
		try {
			const data = readHome(key);
			let songs: PlayerTrack[] = [];
			const fromDevice =
				offline || ((pin.kind === 'artist' || pin.kind === 'album') && !pin.localId && !pin.mbid);
			if (fromDevice) {
				const local = available ?? availableTracks(await offlineInventory(session));
				songs = await devicePinTracks(session, pin, data, local, signal);
			} else
				switch (pin.kind) {
					case 'track':
						songs = [pinTrack(pin)];
						break;
					case 'artist':
						if (pin.localId) onlocal({ id: pin.localId, name: pin.title });
						else if (pin.mbid) onartist({ id: pin.mbid, name: pin.title });
						return;
					case 'album':
						onopen({
							title: pin.title,
							artist: pin.artist ?? '',
							art: pin.art,
							group: pin.mbid,
							localId: pin.localId
						});
						return;
					case 'genre':
						ongenre?.(pin.id);
						return;
					case 'playlist': {
						const current = (await playlists(session, signal)).find((p) => p.id === pin.id);
						if (current && !signal.aborted) onplaylist(current);
						else if (!signal.aborted)
							status = tr(
								'This playlist is no longer available.',
								'このプレイリストは利用できません。'
							);
						return;
					}
					case 'smart': {
						const rule = (await readSmartPlaylists(session)).find((r) => r.id === pin.id);
						if (rule) songs = await smartPlaylistTracks(session, rule, signal);
						break;
					}
					case 'station':
						if (pin.stationType)
							songs = await libraryRadio(session, pin.stationType, pin.id, signal);
						break;
					case 'mix': {
						const m = data.mixes.find((m) => m.id === pin.id);
						if (m) songs = await playMix(session, m, signal);
						break;
					}
				}
			if (signal.aborted) return;
			if (!songs.length) {
				status = fromDevice
					? tr(
							'No tracks for this pin are saved on this device.',
							'このピンの曲は端末に保存されていません。'
						)
					: tr('No playable tracks for this pin.', 'このピンには再生可能な曲がありません。');
				return;
			}
			if (!offline && (pin.kind === 'station' || pin.kind === 'mix')) rememberPlan(key, pin, songs);
			finish();
			await onplay(songs, 0);
		} catch (e) {
			if (!signal.aborted)
				status = onnetworkerror(e)
					? tr(
							'DroppedNeedle is offline. Open the pin again to play saved tracks.',
							'DroppedNeedleはオフラインです。ピンをもう一度開くと保存済みの曲を再生できます。'
						)
					: errorMessage(e);
		} finally {
			finish();
			if (job === request) busy = '';
		}
	}
</script>

{#if store?.pins.length}
	<section class="pins" aria-label={tr('Pinned to Home', 'ホームのピン留め')}>
		<header>
			<h2><Pin size={18} />{tr('Pinned to Home', 'ホームのピン留め')}</h2>
			<button class="text-button" aria-pressed={arranging} onclick={() => (arranging = !arranging)}
				><SlidersHorizontal size={16} />{arranging
					? tr('Done', '完了')
					: tr('Arrange pins', 'ピンを並べ替え')}</button
			>
		</header>
		<ul>
			{#each store.pins as pin, i (pinKey(pin))}
				{@const Icon = icons[pin.kind]}
				<li>
					<button
						class="entry"
						disabled={arranging || busy === pinKey(pin) || (offline && !available)}
						onclick={() => open(pin)}
					>
						<span class="art"
							>{#if pin.kind === 'playlist' || pin.kind === 'smart'}<PlaylistCover
									{session}
									id={pin.kind + ':' + pin.id}
									covers={pin.kind === 'playlist' ? (playlistCovers.get(pin.id) ?? []) : []}
									cacheOnly={offline}
								/>{:else if pin.art}<Cover
									{session}
									path={pin.art}
									seed={pin.id}
									cacheOnly={offline}
								/>{:else}<Icon size={22} />{/if}</span
						>
						<span
							><strong>{pin.title}</strong><small
								>{pinKindLabel(pin.kind)}{#if pin.artist}
									· {pin.artist}{/if}</small
							></span
						>
					</button>
					{#if arranging}<div class="move">
							<button
								aria-label={tr('Move ' + pin.title + ' up', pin.title + 'を上へ')}
								disabled={i === 0}
								onclick={() => rearrange(() => movePin(key, pin, -1))}
								><ChevronUp size={18} /></button
							>
							<button
								aria-label={tr('Move ' + pin.title + ' down', pin.title + 'を下へ')}
								disabled={i === store.pins.length - 1}
								onclick={() => rearrange(() => movePin(key, pin, 1))}
								><ChevronDown size={18} /></button
							>
							<button
								aria-label={tr('Unpin ' + pin.title, pin.title + 'のピン留めを外す')}
								onclick={() => rearrange(() => setPinned(key, pin, false))}><X size={18} /></button
							>
						</div>{/if}
				</li>
			{/each}
		</ul>
		{#if status}<p role="status">{status}</p>{/if}
	</section>
{/if}

<style>
	.pins {
		margin-block-end: 1.2rem;
	}
	header,
	h2,
	li,
	.entry,
	.move {
		display: flex;
		align-items: center;
	}
	header,
	li {
		justify-content: space-between;
		gap: 0.4rem;
	}
	header h2 {
		gap: 0.45rem;
		margin: 0;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		border-bottom: 1px solid var(--line);
	}
	.entry {
		min-height: 54px;
		gap: 0.7rem;
		min-width: 0;
		flex: 1;
		text-align: start;
	}
	.entry:disabled {
		opacity: 1;
	}
	.entry > span:last-child {
		min-width: 0;
	}
	.entry strong,
	small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.entry small {
		color: var(--muted);
	}
	.art {
		display: grid;
		place-items: center;
		width: 38px;
		flex: none;
		color: var(--accent);
	}
	.move button {
		min-width: 36px;
		min-height: 44px;
	}
</style>
