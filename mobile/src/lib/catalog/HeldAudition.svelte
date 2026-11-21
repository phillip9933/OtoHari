<script lang="ts">
	import { uiText } from '../i18n';
	import { onDestroy } from 'svelte';
	import { Headphones } from '@lucide/svelte';
	import { readSmallResponse } from '../readSmallResponse';
	import { apiAddress, type Session } from '../connection';
	import { errorMessage, path } from './catalog';
	let { session, fileId, name }: { session: Session; fileId: number; name: string } = $props();
	let src = $state(''),
		busy = $state(false),
		error = $state(''),
		audio: HTMLAudioElement;
	const controller = new AbortController();
	async function listen() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			if (!src) {
				const url = apiAddress(
					session.serverUrl,
					path('/api/v3/held/files/{file_id}/audio', { file_id: String(fileId) })
				);
				const result = await readSmallResponse(
					session.serverUrl,
					url,
					session.token,
					'preview',
					controller.signal
				);
				if (result.status !== 206 || !result.data)
					throw Error('DN did not return a playable preview.');
				const blob = new Blob([Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))], {
					type: result.type
				});
				controller.signal.throwIfAborted();
				src = URL.createObjectURL(blob);
				audio.src = src;
			}
			for (const other of audio.closest('dialog')?.querySelectorAll('audio') ?? []) {
				if (other !== audio) other.pause();
			}
			await audio.play();
		} catch (e) {
			if (!controller.signal.aborted) error = errorMessage(e);
		} finally {
			busy = false;
		}
	}
	onDestroy(() => {
		controller.abort();
		audio?.pause();
		if (src) URL.revokeObjectURL(src);
	});
</script>

<button class="text-button" disabled={busy} aria-label={'Preview ' + name} onclick={listen}
	><Headphones size={16} aria-hidden="true" />{busy
		? uiText('Loading preview…')
		: uiText('Preview opening audio')}</button
>
<audio
	bind:this={audio}
	controls
	hidden={!src}
	aria-label={'Audio preview of ' + name}
	onerror={() => {
		if (src) error = 'This file’s opening audio could not be played.';
	}}
></audio>
{#if error}<p role="alert">{error}</p>{/if}

<style>
	audio {
		width: 100%;
		max-width: 28rem;
	}
</style>
