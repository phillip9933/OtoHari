<script lang="ts">
	import { tr, uiText } from '../i18n';
	import { EllipsisVertical } from '@lucide/svelte';
	import DiscoverSample from './DiscoverSample.svelte';
	import { observePick, reportPick } from './discoverInteractions';
	import PlaylistDialog from './PlaylistDialog.svelte';
	import { onDestroy } from 'svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { getJson, postJson, type Session } from '../connection';
	import { path, errorMessage, type Album } from './catalog';
	import PreviewItem from '../boards/PreviewItem.svelte';
	import { forgetDiscoveryPage, type DeckCard } from './discoveryWidgets';
	import {
		answerDiscover,
		pickEvidence,
		readFeedback,
		readTunings,
		reduceSeed,
		undoFeedback,
		undoTuning,
		type Answer,
		type Evidence,
		type Feedback,
		type Tuning
	} from './discoverFeedback';
	type S = components['schemas'];
	let {
		session,
		active,
		cards,
		queue,
		onopen,
		onrefresh
	}: {
		session: Session;
		active: boolean;
		cards: DeckCard[];
		queue: boolean;
		onopen: (a: Album) => void;
		onrefresh: () => void;
	} = $props();
	let busy = $state(false),
		hidden = $state(false),
		legacy = $state(false),
		hasFeedback = false,
		selected = $state<DeckCard>(),
		evidence = $state<Evidence>(),
		askedWhy = $state(false),
		ledger = $state<Feedback[]>([]),
		tunings = $state<Tuning[]>([]),
		message = $state(''),
		error = $state('');
	let live = true,
		timer: ReturnType<typeof setTimeout>;
	onDestroy(() => {
		live = false;
		clearTimeout(timer);
	});
	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = message = '';
		try {
			await action();
		} catch (cause) {
			if (live) error = errorMessage(cause);
		} finally {
			if (live) busy = false;
		}
	}
	function answerLabel(kind: Answer) {
		switch (kind) {
			case 'no':
				return tr('Not for me', '好みではない');
			case 'know_it':
				return tr('Know it already', 'すでに知っている');
			case 'not_now':
				return tr('Not now', '今は表示しない');
			case 'not_artist':
				return tr('Not this artist', 'このアーティストを表示しない');
		}
	}
	async function openFeedback(card?: DeckCard) {
		const result = await readFeedback(session);
		if (!live) return;
		hasFeedback = true;
		legacy = result.legacy;
		ledger = result.items;
		selected = card;
		evidence = undefined;
		askedWhy = false;
		hidden = !card;
		tunings = [];
		if (!card && !legacy) {
			const rows = await readTunings(session);
			if (live) tunings = rows;
		}
	}
	function showRecommendations() {
		hidden = false;
		forgetDiscoveryPage(session);
		onrefresh();
	}
	function foreground() {
		if (document.hidden || !active || busy || selected) return;
		if (hidden) {
			void run(() => openFeedback());
		} else {
			forgetDiscoveryPage(session);
			onrefresh();
			if (hasFeedback)
				void run(async () => {
					const result = await readFeedback(session);
					if (live) ledger = result.items;
				});
		}
	}
	async function answer(card: DeckCard, kind: Answer) {
		const result = await answerDiscover(session, card, kind, legacy, queue);
		forgetDiscoveryPage(session);
		if (!live) return;
		ledger = [
			...ledger.filter((r) => r.target !== result.target || r.target_mbid !== result.target_mbid),
			result
		];
		selected = undefined;
		message = tr('Discover feedback saved.', 'おすすめのフィードバックを保存しました。');
	}
	async function restore(row: Feedback) {
		await undoFeedback(session, row, legacy);
		forgetDiscoveryPage(session);
		if (!live) return;
		ledger = ledger.filter((r) => r.target !== row.target || r.target_mbid !== row.target_mbid);
		message = tr('Discover feedback removed.', 'おすすめのフィードバックを取り消しました。');
	}
	async function why(id: string) {
		const result = await pickEvidence(session, id);
		if (!live) return;
		evidence = result;
		askedWhy = true;
	}
	async function tune(id: string) {
		await reduceSeed(session, id);
		forgetDiscoveryPage(session);
		if (!live || !evidence) return;
		evidence = {
			...evidence,
			seeds: evidence.seeds.map((seed) =>
				seed.artist_mbid === id ? { ...seed, turned_down: true } : seed
			)
		};
	}
	async function removeTuning(row: Tuning) {
		await undoTuning(session, row);
		forgetDiscoveryPage(session);
		if (live) tunings = tunings.filter((r) => r.kind !== row.kind || r.target !== row.target);
	}
	async function checkStatus(remaining: number) {
		try {
			const state = await getJson<S['DiscoverQueueStatusResponse']>(
				session,
				path('/api/v3/discover/queue/status')
			);
			if (!live) return;
			if (state.status === 'building' && remaining > 0) {
				timer = setTimeout(() => void checkStatus(remaining - 1), 4000);
				return;
			}
			if (state.status === 'ready') {
				message = 'Queue updated.';
				onrefresh();
			} else if (state.status === 'error') {
				error = state.error || 'DroppedNeedle could not build the discovery queue.';
				message = '';
			} else {
				message = 'The queue is still being prepared. Open it again to check.';
			}
		} catch (cause) {
			if (live) {
				error = errorMessage(cause);
				message = '';
			}
		}
	}
	async function refresh() {
		clearTimeout(timer);
		const result = await postJson<S['QueueGenerateResponse']>(
			session,
			path('/api/v3/discover/queue/generate'),
			{ force: true } satisfies S['QueueGenerateRequest']
		);
		if (!live) return;
		if (result.status === 'ready') {
			onrefresh();
			message = 'Queue updated.';
		} else if (result.status === 'building') {
			message = 'DroppedNeedle is updating your queue.';
			timer = setTimeout(() => void checkStatus(12), 4000);
		} else {
			error = result.error || 'DroppedNeedle could not build the discovery queue.';
		}
	}
	const hiddenAlbums = $derived(
		new Set(ledger.filter((r) => r.target === 'album').map((r) => r.target_mbid.toLowerCase()))
	);
	const hiddenArtists = $derived(
		new Set(ledger.filter((r) => r.target === 'artist').map((r) => r.target_mbid.toLowerCase()))
	);
	const shown = $derived(
		cards.filter(
			(card) =>
				!hiddenAlbums.has(card.album.group?.toLowerCase() ?? '') &&
				!hiddenArtists.has(card.artistId?.toLowerCase() ?? '')
		)
	);
	const answers: Answer[] = ['no', 'know_it', 'not_now', 'not_artist'];
</script>

<svelte:document onvisibilitychange={foreground} />

<div class="tools">
	{#if queue}<button class="secondary" disabled={busy} onclick={() => run(refresh)}
			>{uiText('Refresh queue')}</button
		>{/if}<button
		class="secondary"
		disabled={busy}
		aria-pressed={hidden}
		onclick={() => (hidden ? showRecommendations() : run(() => openFeedback()))}
		>{hidden
			? uiText('Show recommendations')
			: tr('Discover feedback', 'おすすめのフィードバック')}</button
	>
</div>
<div class="preview-items">
	{#if hidden}
		{#each ledger as row (`${row.target}:${row.target_mbid}`)}
			{@const name =
				(row.target === 'artist' ? row.artist_name : row.release_name) || row.target_mbid}
			<PreviewItem
				{session}
				title={name}
				subtitle={answerLabel(row.kind)}
				detail={row.expires_at
					? tr('Back after ', '再表示日：') + new Date(row.expires_at * 1000).toLocaleDateString()
					: undefined}
			>
				{#snippet actions()}<button
						class="text-button"
						disabled={busy}
						onclick={() => run(() => restore(row))}>{uiText('Undo')} {name}</button
					>{/snippet}
			</PreviewItem>
		{/each}
		{#each tunings as row (`${row.kind}:${row.target}`)}
			<PreviewItem
				{session}
				title={row.name || row.target}
				subtitle={tr('Suggest less from this artist', 'このアーティストに基づくおすすめを減らす')}
			>
				{#snippet actions()}<button
						class="text-button"
						disabled={busy}
						onclick={() => run(() => removeTuning(row))}
						>{uiText('Undo')} {row.name || row.target}</button
					>{/snippet}
			</PreviewItem>
		{/each}
		{#if !ledger.length && !tunings.length && !busy && !error}<p>
				{tr('No Discover feedback yet.', 'おすすめのフィードバックはまだありません。')}
			</p>{/if}
	{:else}{#each shown as card, i (`${i}-${card.album.group ?? card.album.title}`)}
			<PreviewItem
				{session}
				part="album-card"
				title={card.album.title}
				subtitle={card.album.artist}
				detail={card.reason}
				artwork={card.album.art}
				coverSeed={card.album.group || card.album.localId || card.album.title}
				observe={observePick(session, card.album.group, active)}
				onclick={() => {
					void reportPick(session, card.album.group, 'opened');
					onopen(card.album);
				}}
			>
				{#snippet actions()}{#if card.album.group || card.artistId}<button
							class="icon-button"
							disabled={busy}
							aria-label={tr('Feedback for ', 'フィードバック：') + card.album.title}
							onclick={() => run(() => openFeedback(card))}><EllipsisVertical size={20} /></button
						>{/if}{/snippet}
			</PreviewItem>
		{:else}<p>{uiText('No recommended albums yet.')}</p>{/each}{/if}
</div>
{#if selected}
	{@const card = selected}
	<PlaylistDialog
		title={card.album.title}
		{busy}
		onclose={() => {
			selected = undefined;
			error = '';
		}}
	>
		<div class="actions">
			{#if card.album.group}<DiscoverSample {session} {card} {active} />{/if}
			{#if legacy}
				{#if card.album.group && card.artistId}<button
						disabled={busy}
						onclick={() => run(() => answer(card, 'no'))}
						>{tr('Hide album', 'アルバムを非表示')}</button
					>
				{:else}<p>
						{tr(
							'This server needs both album and artist IDs to hide a recommendation.',
							'このサーバーでおすすめを非表示にするには、アルバムとアーティストの両方のIDが必要です。'
						)}
					</p>{/if}
			{:else}
				{#each answers as kind (kind)}
					{#if kind === 'not_artist' ? card.artistId : card.album.group}
						<button disabled={busy} onclick={() => run(() => answer(card, kind))}
							>{answerLabel(kind)}</button
						>
					{/if}
				{/each}
				{#if card.album.group && !askedWhy}
					<button disabled={busy} onclick={() => run(() => why(card.album.group!))}
						>{tr('Why this pick?', 'このおすすめの理由')}</button
					>
				{:else if askedWhy}
					<p>
						{evidence?.reason.line ||
							card.reason ||
							tr('No further details available.', '詳細はありません。')}
					</p>
					{#each evidence?.seeds ?? [] as seed (seed.artist_mbid)}
						<button
							disabled={busy || seed.turned_down}
							onclick={() => run(() => tune(seed.artist_mbid))}
						>
							{seed.turned_down
								? tr('Reduced recommendations from ', 'おすすめを減らしました：')
								: tr(
										'Suggest less based on ',
										'このアーティストに基づくおすすめを減らす：'
									)}{seed.name}
						</button>
					{/each}
				{/if}
			{/if}
			<button
				disabled={busy}
				onclick={() => {
					selected = undefined;
					error = '';
				}}>{uiText('Close')}</button
			>
		</div>
		{#if error}<p role="alert">{error}</p>{/if}
	</PlaylistDialog>
{/if}
{#if message}<p role="status">{message}</p>{/if}{#if error && !selected}<p role="alert">
		{error}
	</p>{/if}

<style>
	.actions {
		display: grid;
	}
	.actions button {
		min-height: 44px;
		padding: 0.4rem 0.3rem;
		text-align: start;
		border-bottom: 1px solid var(--line);
	}
	.tools {
		display: flex;
		gap: 0.55rem;
		flex-wrap: wrap;
		margin-bottom: var(--gap);
	}
</style>
