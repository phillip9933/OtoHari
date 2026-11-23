<script lang="ts">
	import type { Session } from '../connection';
	import { tr } from '../i18n';
	import { updatePlaylistCover } from './playlistCoverSync';
	import type { Playlist } from './playlists';
	import { errorMessage } from './catalog';
	import {
		coverFromFile,
		forgetPlaylistCover,
		playlistCoverOverride,
		savePlaylistCover
	} from './playlistCoverOverrides';

	let {
		session,
		id,
		playlist,
		ondone
	}: {
		session: Session;
		id: string;
		playlist?: Playlist;
		ondone: () => void;
	} = $props();
	const smart = $derived(id.startsWith('smart:'));
	const owner = $derived(playlist?.is_owner === true && id === 'playlist:' + playlist.id);
	const cover = $derived(playlistCoverOverride(session, id));
	let input = $state<HTMLInputElement>();
	let busy = $state(false);
	let error = $state('');
	async function save(image?: File | string) {
		if (busy || (!smart && !owner)) return;
		const account = session,
			key = id,
			target = smart ? undefined : playlist?.id;
		busy = true;
		error = '';
		try {
			const source = image instanceof File ? await coverFromFile(image) : image;
			if (target !== undefined) {
				await updatePlaylistCover(account, target, source);
				if ($cover) await forgetPlaylistCover(account, key);
			} else {
				await savePlaylistCover(account, key, source);
			}
			ondone();
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			busy = false;
		}
	}
</script>

{#if owner || smart}
	<input
		hidden
		bind:this={input}
		type="file"
		accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
		onchange={() => {
			if (!input) return;
			const file = input.files?.[0];
			input.value = '';
			if (file) void save(file);
		}}
	/>
	<button class="art-action" type="button" disabled={busy} onclick={() => input?.click()}>
		{smart
			? tr('Choose artwork on this device', 'この端末の画像を選択')
			: tr('Choose artwork', '画像を選択')}
	</button>
	{#if owner && $cover}<button
			class="art-action"
			type="button"
			disabled={busy}
			onclick={() => save($cover)}
		>
			{tr('Use previous device artwork on DroppedNeedle', '以前の端末の画像をDroppedNeedleで使用')}
		</button>{/if}
	{#if smart ? $cover : playlist?.custom_cover_url}<button
			class="art-action"
			type="button"
			disabled={busy}
			onclick={() => save()}
		>
			{tr('Use automatic artwork', '自動アートワークに戻す')}
		</button>{/if}
	{#if error}<p role="alert">{error}</p>{/if}
{/if}

<style>
	.art-action {
		min-height: 44px;
		padding: 0.4rem 0.3rem;
		text-align: start;
		border-bottom: 1px solid var(--line);
	}
</style>
