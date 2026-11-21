<script lang="ts">
	import { onMount } from 'svelte';
	import type { Session } from '../connection';
	import { tr, uiText } from '../i18n';
	import { errorMessage } from '../catalog/catalog';
	import { player } from '../player';

	let { session }: { session: Session } = $props();
	let enabled = $state<boolean>(),
		busy = $state(false),
		error = $state('');
	async function update(value?: boolean) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			enabled = (await player.autoplaySetting(session, value)).enabled;
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		void update();
	});
</script>

<div id="queue-autoplay" class="settings-panel" data-surface="panel">
	<label>
		<input
			type="checkbox"
			checked={enabled ?? false}
			disabled={busy || enabled === undefined}
			aria-describedby="queue-autoplay-help"
			onchange={(event) => {
				const next = event.currentTarget.checked;
				event.currentTarget.checked = enabled ?? false;
				void update(next);
			}}
		/>
		{tr('Autoplay when the queue ends', 'キューの終了時に自動再生')}
	</label>
	<p id="queue-autoplay-help">
		{uiText('When the queue ends, continue with related songs from your DroppedNeedle library.')}
	</p>
	{#if error}<p role="alert">{error}</p>
		{#if enabled === undefined}<button class="secondary" onclick={() => void update()}
				>{uiText('Try again')}</button
			>{/if}
	{/if}
</div>
