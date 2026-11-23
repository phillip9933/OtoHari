<script lang="ts">
	import { deviceLink } from '../playback/deviceLink';
	import Input from '../../../ui/Input.svelte';
	const field = $props.id();
	const name = $derived($deviceLink.name);
	let draft = $derived(name);
	const here = $derived($deviceLink.devices.find((d) => d.id === $deviceLink.id));
	const others = $derived($deviceLink.devices.filter((d) => d.id !== $deviceLink.id));
</script>

<section class="device-list" aria-label="Player handoff">
	<label class="allow"
		><input
			type="checkbox"
			checked={$deviceLink.enabled}
			onchange={(e) => deviceLink.setEnabled(e.currentTarget.checked)}
		/> Allow other signed-in players to control this player</label
	>
	{#if $deviceLink.enabled}
		<div class="player-name">
			<label for={field}>Player name</label><Input
				id={field}
				label="Player name"
				bind:value={draft}
				maxlength={60}
				onblur={() => deviceLink.setName(draft)}
				onkeydown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
				}}
			/>
		</div>
		{#if here?.title}<p aria-label="Playing on this device">
				This player · {here.title} · {here.playing ? 'Playing' : 'Paused'}
			</p>{/if}
		{#if here?.title && !here.can_transfer}<p>
				To move this queue, choose a fully loaded selection of up to 2,000 local DN songs.
			</p>{/if}
		{#if $deviceLink.issue}<p role="alert">{$deviceLink.issue}</p>
			<button class="secondary" onclick={deviceLink.refresh}>Check again</button>
		{:else if !others.length}<p>
				Open Player handoff on another device signed in to this DN account and enable it there.
			</p>{/if}
		{#each others as peer (peer.id)}
			<article>
				<strong>{peer.name}</strong><small
					>{peer.title ?? 'No music queued'}{peer.title
						? peer.playing
							? ' · Playing'
							: ' · Paused'
						: ''}</small
				>
				<div>
					{#if here?.can_transfer}<button
							disabled={$deviceLink.working || peer.busy || here.busy}
							onclick={() => deviceLink.control($deviceLink.id, 'transfer', peer.id)}
							>Move queue there</button
						>{/if}
					{#if peer.can_transfer}<button
							disabled={$deviceLink.working || peer.busy || here?.busy}
							onclick={() => deviceLink.control(peer.id, 'transfer', $deviceLink.id)}
							>Continue here</button
						>{/if}
					{#if peer.title}
						<button
							disabled={$deviceLink.working || peer.busy}
							onclick={() => deviceLink.control(peer.id, 'previous')}>Previous</button
						>
						<button
							disabled={$deviceLink.working || peer.busy}
							onclick={() => deviceLink.control(peer.id, peer.playing ? 'pause' : 'play')}
							>{peer.playing ? 'Pause' : 'Play'}</button
						>
						<button
							disabled={$deviceLink.working || peer.busy}
							onclick={() => deviceLink.control(peer.id, 'next')}>Next</button
						>
					{/if}
				</div>
				{#if peer.error}<small role="status">{peer.error}</small>{/if}
			</article>
		{/each}
	{/if}
</section>

<style>
	.device-list,
	article,
	label {
		display: grid;
		gap: 0.6rem;
	}
	.device-list {
		gap: 1rem;
	}
	.allow {
		display: flex;
		align-items: center;
		gap: 0.65rem;
	}
	article {
		border-top: 1px solid var(--line, var(--color-border, currentColor));
		padding-block: 0.8rem;
	}
	article div {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
	}
	article button {
		min-height: 44px;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--line, var(--color-border, currentColor));
		border-radius: 0.65rem;
	}
	small {
		opacity: 0.78;
	}
</style>
