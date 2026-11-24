<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { ChevronDown, ChevronUp } from '@lucide/svelte';
	import { tr } from '../i18n';
	import type { Session } from '../connection';
	import { decideBatch, type ApprovalCard, type Action } from './requestActions';

	let {
		session,
		card,
		onreview
	}: { session: Session; card: ApprovalCard; onreview: (action: Action) => void } = $props();
	let expanded = $state(false);
	const excluded = new SvelteSet<string>();
	const selected = $derived(card.items.filter((item) => !excluded.has(item.musicbrainz_id)));
	function toggle(id: string) {
		if (excluded.has(id)) excluded.delete(id);
		else excluded.add(id);
	}
	function review(rejectAll = false) {
		const approve = rejectAll ? [] : selected.map((item) => item.musicbrainz_id);
		const rejected = card.items.length - approve.length;
		onreview({
			label: rejectAll
				? tr('Reject all', 'すべて却下')
				: tr('Approve selection', '選択したアルバムを承認'),
			effect: tr(
				`Approve ${approve.length} and reject ${rejected} from this playlist request?`,
				`このリクエストの${approve.length}件を承認し、${rejected}件を却下しますか？`
			),
			run: async () => {
				const result = await decideBatch(session, card.id, approve);
				return tr(
					`Approved ${result.approved}, rejected ${result.rejected}.`,
					`承認：${result.approved}件、却下：${result.rejected}件。`
				);
			}
		});
	}
</script>

<section
	class="batch"
	aria-label={tr('Playlist request', 'プレイリストのリクエスト') + ' · ' + card.name}
	data-surface="panel"
>
	<button class="toggle" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
		<strong>{card.name}</strong>
		{#if expanded}<ChevronUp size={18} aria-hidden="true" />{:else}<ChevronDown
				size={18}
				aria-hidden="true"
			/>{/if}
		<span
			>{tr(
				`${card.items.length} ${card.items.length === 1 ? 'album' : 'albums'} · Requested by ${card.requester_name}`,
				`アルバム${card.items.length}件 · リクエスト：${card.requester_name}`
			)}</span
		>
	</button>
	{#if expanded}
		<ul>
			{#each card.items as item (item.musicbrainz_id)}
				<li>
					<label
						><input
							type="checkbox"
							checked={!excluded.has(item.musicbrainz_id)}
							onchange={() => toggle(item.musicbrainz_id)}
						/><span>{item.title}<small>{item.artist_name}</small></span></label
					>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="settings-actions">
		<button class="primary" disabled={!selected.length} onclick={() => review()}
			>{tr(`Approve ${selected.length}`, `${selected.length}件を承認`)}</button
		>
		<button class="secondary" onclick={() => review(true)}>{tr('Reject all', 'すべて却下')}</button>
	</div>
</section>

<style>
	.batch {
		padding: 0.8rem;
		margin-block: 0.55rem;
	}
	.toggle {
		display: grid;
		gap: 0.2rem;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		min-height: 44px;
		width: 100%;
		text-align: start;
		background: none;
		color: inherit;
		border: 0;
		padding: 0.25rem 0 0.6rem;
	}
	.toggle span {
		grid-column: 1/-1;
	}
	.toggle span,
	small {
		color: var(--muted);
	}
	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	label {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		min-height: 44px;
	}
	input {
		width: 1.15rem;
		height: 1.15rem;
	}
	small {
		display: block;
	}
</style>
