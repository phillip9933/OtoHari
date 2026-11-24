<script lang="ts">
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { apiAddress, DnError, getJson, type Session } from '../connection';
	import { readSmallResponse } from '../readSmallResponse';
	import { tr } from '../i18n';
	import { player } from '../player';
	import { path, errorMessage } from './catalog';
	import { reportPick } from './discoverInteractions';
	import type { DeckCard } from './discoveryWidgets';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';

	let { session, card, active }: { session: Session; card: DeckCard; active: boolean } = $props();
	let src = $state(''),
		title = $state(''),
		busy = $state(false),
		error = $state('');
	let audio = $state<HTMLAudioElement>();
	let reported = false;
	const controller = new AbortController();
	const missing = () =>
		tr(
			'No sample in your DroppedNeedle library.',
			'DroppedNeedleライブラリに試聴できる曲がありません。'
		);
	function stopSample() {
		audio?.pause();
	}
	$effect(() => {
		if (!active) stopSample();
	});
	onDestroy(() => {
		controller.abort();
		stopSample();
		if (src) URL.revokeObjectURL(src);
	});
	async function findSample() {
		const id = card.album.localId || card.album.group;
		if (busy || !id) return;
		busy = true;
		error = '';
		try {
			const page = await getJson<components['schemas']['TrackPage']>(
				session,
				path('/api/v3/library/albums/match/{mbid}', { mbid: id }, { limit: 1, offset: 0 }),
				controller.signal
			);
			const track = page.items[0];
			if (!track?.id) {
				error = missing();
				return;
			}
			const url = apiAddress(
				session.serverUrl,
				path('/api/v3/stream/{source}/{*key}', { source: 'local', '*key': track.id })
			);
			const result = await readSmallResponse(
				session.serverUrl,
				url,
				session.token,
				'preview',
				controller.signal
			);
			if (result.status !== 206 || !result.data) {
				error = missing();
				return;
			}
			controller.signal.throwIfAborted();
			const clip = new Blob([Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))], {
				type: result.type
			});
			src = URL.createObjectURL(clip);
			title = track.title;
		} catch (e) {
			if (!controller.signal.aborted)
				error = e instanceof DnError && e.status === 404 ? missing() : errorMessage(e);
		} finally {
			busy = false;
		}
	}
	function started() {
		if (!active || document.hidden) {
			stopSample();
			return;
		}
		if (!reported) {
			reported = true;
			void reportPick(session, card.album.group, 'sampled');
		}
		if (get(player).playing) void player.setPlaying(false).catch(() => {});
	}
	function limitSample() {
		if (!audio || audio.currentTime < 30) return;
		audio.pause();
		audio.currentTime = 0;
	}
</script>

<svelte:document
	onvisibilitychange={() => {
		if (document.hidden) stopSample();
	}}
/>
{#if src}
	<span>{title}</span>
	<audio
		bind:this={audio}
		controls
		preload="none"
		{src}
		onplaying={started}
		ontimeupdate={limitSample}
		onerror={() => (error = missing())}
		aria-label={tr('Album sample', 'アルバムの試聴')}
	></audio>
{:else}
	<button disabled={busy} onclick={findSample}>{tr('Preview album', 'アルバムを試聴')}</button>
{/if}
{#if error}<p role="status">{error}</p>{/if}

<style>
	button {
		min-height: 44px;
		text-align: start;
		border-bottom: 1px solid var(--line);
	}
	audio {
		width: 100%;
	}
</style>
