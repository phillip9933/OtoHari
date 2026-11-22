<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ArrowLeft, EllipsisVertical } from '@lucide/svelte';
	import type { Session } from '../connection';
	import { tr, uiText } from '../i18n';
	import type { PlayerTrack } from '../player';
	import PlayerSheet from '../player/PlayerSheet.svelte';
	import Cover from './Cover.svelte';
	import DetailSettings from './DetailSettings.svelte';
	import HomePinButton from './HomePinButton.svelte';
	import { artistPin, stationPin, type HomePin } from './homePins';
	import LibraryRadio from './LibraryRadio.svelte';
	import type { OnPlay } from './catalog';
	import { artistArtwork } from './artistArtwork';
	import WebDetail from './WebDetail.svelte';

	let {
		session,
		name,
		localId,
		mbid,
		backLabel,
		onback,
		onplay,
		radioFirst = false,
		device,
		actions,
		moreActions
	}: {
		session: Session;
		name: string;
		localId?: string | null;
		mbid?: string | null;
		backLabel: string;
		onback: () => void;
		onplay: OnPlay;
		radioFirst?: boolean;
		device?: { pin?: HomePin; art?: string };
		actions: Snippet;
		moreActions?: Snippet<[() => void]>;
	} = $props();
	let open = $state(false),
		previous = $state.raw<PlayerTrack[]>([]);
	const pinnedTarget = $derived(device ? device.pin : artistPin(name, localId, mbid));
	const identityKey = $derived(localId || mbid || device?.pin?.id || name);
	const picture = $derived(artistArtwork(mbid, localId));
	$effect(() => {
		void session;
		void identityKey;
		open = false;
		previous = [];
	});
	function close() {
		open = false;
	}
</script>

{#snippet radio(primary: boolean)}
	{#if mbid}
		<LibraryRadio
			{session}
			seedType="artist"
			seedId={mbid}
			seedTitle={name}
			{onplay}
			showPin={false}
			label={tr('Play artist radio', 'アーティストラジオを再生')}
			onplan={(tracks) => (previous = tracks)}
			onstart={primary ? undefined : close}
		/>
	{/if}
{/snippet}

<header class="artist-header" data-part="artist-header" data-detail-header>
	<div class="identity">
		<button class="back" aria-label={uiText(backLabel)} title={uiText(backLabel)} onclick={onback}
			><ArrowLeft size={21} /></button
		>
		<div class="portrait">
			<Cover
				{session}
				path={device ? device.art : picture.art}
				cacheOnly={!!device}
				fallback={device ? undefined : picture.fallbackArt}
				seed={identityKey}
			/>
		</div>
		<div class="name">
			<h1>{name}</h1>
			{#if device}<small>{uiText('On this device')}</small>{/if}
		</div>
		<DetailSettings />
	</div>
	<div class="artist-actions">
		{#if radioFirst}{@render radio(true)}{/if}
		{@render actions()}
		{#if pinnedTarget || mbid || localId}<button
				class="more icon-button"
				aria-label={tr('More artist actions', 'アーティストのその他の操作')}
				aria-haspopup="dialog"
				aria-expanded={open}
				onclick={() => (open = true)}><EllipsisVertical size={21} /></button
			>{/if}
	</div>
</header>
{#if open}
	<PlayerSheet
		title={tr('Artist actions', 'アーティストの操作')}
		context={name}
		closeLabel={uiText('Close')}
		onclose={close}
	>
		<div class="menu-actions">
			{#if !radioFirst}{@render radio(false)}{/if}
			{#if moreActions}{@render moreActions(close)}{/if}
			<HomePinButton
				{session}
				pin={pinnedTarget}
				compact
				labels={{
					add: device
						? tr('Pin artist to Home', 'アーティストをホームにピン留め')
						: tr('Pin artist page to Home', 'アーティストページをホームにピン留め'),
					remove: device
						? tr('Unpin artist from Home', 'ホームからアーティストを外す')
						: tr('Unpin artist page from Home', 'ホームからアーティストページを外す')
				}}
				ondone={close}
			/>
			{#if mbid}<HomePinButton
					{session}
					pin={stationPin('artist', mbid, name)}
					tracks={previous}
					compact
					labels={{
						add: tr('Pin artist radio to Home', 'アーティストラジオをホームにピン留め'),
						remove: tr('Unpin artist radio from Home', 'ホームからアーティストラジオを外す')
					}}
					ondone={close}
				/>{/if}
			{#if localId}<WebDetail
					{session}
					route={'/library/artists/' + encodeURIComponent(localId)}
					label={uiText('Open artist in web app')}
					onopen={close}
				/>{/if}
		</div>
	</PlayerSheet>
{/if}

<style>
	.artist-header {
		display: grid;
		gap: 0.35rem;
		margin-block: 0 0.65rem;
	}
	.identity {
		display: flex;
		gap: 0.45rem;
		align-items: center;
		min-width: 0;
	}
	.identity .name {
		min-width: 0;
		flex: 1;
	}
	.name small {
		color: var(--muted);
	}
	.portrait {
		width: clamp(2.75rem, 10vw, 3.25rem);
		flex: none;
		overflow: hidden;
		border-radius: 50%;
	}
	h1 {
		margin: 0;
		min-width: 0;
		font-size: clamp(1.45rem, 5.5vw, 2.15rem);
		line-height: 1.1;
		overflow-wrap: anywhere;
	}
	.back,
	.more {
		width: 44px;
		min-height: 44px;
		display: grid;
		place-items: center;
		flex: none;
		border-radius: 50%;
	}
	.back {
		margin-inline-start: -0.35rem;
	}
	.artist-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}
	.artist-actions :global(.secondary),
	.artist-actions :global(.primary) {
		border-radius: 99px;
		min-height: 44px;
		padding: 0.35rem 0.85rem;
	}
	.artist-actions :global([role='status']),
	.artist-actions :global([role='alert']) {
		flex-basis: 100%;
		order: 1;
		margin: 0;
	}
	.menu-actions {
		display: grid;
	}
	.menu-actions :global(button),
	.menu-actions :global(a) {
		width: 100%;
		display: flex;
		gap: 0.7rem;
		align-items: center;
		justify-content: flex-start;
		margin: 0;
		min-height: 48px;
		text-align: start;
		background: transparent;
		border: 0;
		box-shadow: none;
		padding: 0.45rem 0.3rem;
		color: var(--text);
		font-weight: 500;
	}
	.menu-actions :global(a svg) {
		order: -1;
	}
</style>
