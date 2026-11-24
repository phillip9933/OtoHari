<script lang="ts">
	import { uiText, tr } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { onMount } from 'svelte';
	import { Browser } from '@capacitor/browser';
	import { Capacitor } from '@capacitor/core';
	import WantedWatches from './WantedWatches.svelte';
	import HeldReview from './HeldReview.svelte';
	import RequestCandidates from './RequestCandidates.svelte';
	import PlaylistApprovalCard from './PlaylistApprovalCard.svelte';
	import RequestRecord from './RequestRecord.svelte';
	import PlayerSheet from '../player/PlayerSheet.svelte';
	import {
		Check,
		ChevronRight,
		ExternalLink,
		Eye,
		FolderSearch,
		ListFilter,
		RefreshCw
	} from '@lucide/svelte';
	import type { Session } from '../connection';
	import {
		activeRequests,
		cover,
		requestHistory,
		requestedAlbum,
		statusLabel,
		errorMessage,
		type Album,
		type RequestItem
	} from './catalog';
	import {
		approvals,
		approvalBatches,
		type ApprovalCard,
		requestViewer,
		requestActions,
		taskActions,
		downloadGroups,
		downloadPage as loadDownloadPage,
		taskState,
		type Action,
		type Download,
		type Viewer
	} from './requestActions';
	let { session, onopen }: { session: Session; onopen: (a: Album) => void } = $props();
	type View = 'requests' | 'approvals' | 'downloads';
	let view = $state<View>('requests'),
		viewer = $state<Viewer | null>(null);
	let active = $state<RequestItem[]>([]),
		history = $state<RequestItem[]>([]),
		pending = $state<RequestItem[]>([]),
		batches = $state<ApprovalCard[]>([]),
		tasks = $state<Download[]>([]);
	let busy = $state(false),
		error = $state(''),
		profileError = $state(''),
		receipt = $state('');
	let page = $state(1),
		pages = $state(1),
		downloadPage = $state(1),
		moreDownloads = $state(false);
	let menu = $state<{ title: string; options: Action[] } | null>(null),
		selected = $state<Action | null>(null);
	let reviewing = $state<{ jobId: string; title: string; taskId?: string } | null>(null);
	let held = $state<{ taskId?: string; title?: string } | null>(null);
	let read: AbortController | null = null;
	let watchesOpen = $state(false);
	let historyStatus = $state(''),
		historySort = $state('');
	let historyTotal = $state(0);
	let shown = $state<Record<string, number>>({});
	const downloadSections = $derived(downloadGroups(tasks));
	const tabs = $derived<{ id: View; label: string }[]>([
		{ id: 'requests', label: 'Activity' },
		{ id: 'downloads', label: 'Downloads' },
		...(viewer?.role === 'admin' ? [{ id: 'approvals' as const, label: 'Approvals' }] : [])
	]);
	function tabKey(event: KeyboardEvent, index: number) {
		const last = tabs.length - 1;
		const target = {
			ArrowRight: (index + 1) % tabs.length,
			ArrowLeft: (index + last) % tabs.length,
			Home: 0,
			End: last
		}[event.key];
		if (target == null) return;
		event.preventDefault();
		const next = tabs[target].id;
		document.getElementById('requests-tab-' + next)?.focus();
		switchView(next);
	}
	function updateHistory() {
		history = [];
		pages = 1;
		page = 1;
		void refresh(1);
	}
	let manualJobs = $state<Record<string, string>>({});
	function closeReview(finished = false) {
		if (finished && reviewing?.taskId) delete manualJobs[reviewing.taskId];
		reviewing = null;
	}
	function downloadRow(task: Download, title: string) {
		if (task.held_for_review && viewer && (viewer.role === 'admin' || viewer.id === task.user_id))
			return { label: 'Review held files', open: () => (held = { taskId: task.id, title }) };
		const jobId = task.search_job_id;
		if (
			task.status === 'queued' &&
			jobId &&
			task.candidate_index == null &&
			viewer?.id === task.user_id
		)
			return { label: 'Review matches', open: () => (reviewing = { jobId, title }) };
		const options = taskActions(
			session,
			viewer,
			task,
			(jobId) => {
				if (mounted) {
					manualJobs[task.id] = jobId;
					reviewing = { jobId, title, taskId: task.id };
				}
			},
			manualJobs[task.id]
		);
		return { actions: options.length ? () => open(title, options) : undefined };
	}
	const serverTools = $derived([
		{ label: 'Manage wanted watches', route: '/requests?tab=wanted' },
		...(viewer?.role === 'admin' || viewer?.role === 'trusted'
			? [
					{ label: 'Import files into the library', route: '/downloads?tab=import' },
					{ label: 'Review quality upgrades', route: '/requests?tab=upgrades' }
				]
			: []),
		...(viewer?.role === 'admin'
			? [
					{ label: 'Manage auto-downloads', route: '/requests?tab=auto-download' },
					{ label: 'Inspect quarantined downloads', route: '/downloads' }
				]
			: [])
	]);
	async function launchWeb(event: MouseEvent) {
		if (!Capacitor.isNativePlatform()) return;
		event.preventDefault();
		const url = (event.currentTarget as HTMLAnchorElement).href;
		try {
			await Browser.open({ url });
		} catch (e) {
			actionError = errorMessage(e);
		}
	}
	let actionError = $state(''),
		sending = $state(false);
	let mounted = true,
		version = 0;
	async function profile() {
		try {
			const me = await requestViewer(session);
			if (mounted) {
				viewer = me;
				profileError = '';
			}
		} catch (cause) {
			if (mounted) profileError = errorMessage(cause);
		}
	}
	async function refresh(wanted = view === 'downloads' ? downloadPage : page) {
		read?.abort();
		const controller = new AbortController();
		read = controller;
		const sequence = ++version;
		busy = true;
		error = '';
		try {
			if (view === 'requests') {
				const [live, past] = await Promise.all([
					activeRequests(session),
					requestHistory(session, wanted, historyStatus || undefined, historySort || undefined)
				]);
				if (sequence !== version) return;
				active = live.items;
				history = past.items;
				historyTotal = past.total ?? past.items.length;
				page = past.page;
				pages = past.total_pages;
			} else if (view === 'approvals' && viewer?.role === 'admin') {
				const [individual, grouped] = await Promise.allSettled([
					approvals(session, controller.signal),
					approvalBatches(session, controller.signal)
				]);
				if (sequence !== version) return;
				if (individual.status === 'fulfilled') pending = individual.value.items;
				if (grouped.status === 'fulfilled') batches = grouped.value;
				const messages: string[] = [];
				if (individual.status === 'rejected')
					messages.push(
						tr(
							'Individual approvals could not be refreshed.',
							'個別の承認待ちリクエストを更新できませんでした。'
						) +
							' ' +
							errorMessage(individual.reason)
					);
				if (grouped.status === 'rejected')
					messages.push(
						tr(
							'Playlist approvals could not be refreshed.',
							'プレイリストの承認待ちリクエストを更新できませんでした。'
						) +
							' ' +
							errorMessage(grouped.reason)
					);
				error = messages.join(' ');
			} else if (view === 'downloads') {
				const reply = await loadDownloadPage(session, wanted, controller.signal);
				if (sequence !== version) return;
				tasks = reply.items;
				downloadPage = wanted;
				moreDownloads = reply.more;
			}
		} catch (cause) {
			if (sequence === version) error = errorMessage(cause);
		} finally {
			if (sequence === version) busy = false;
		}
	}
	function switchView(next: View) {
		if (next === view) return;
		view = next;
		receipt = '';
		actionError = '';
		void refresh();
	}
	function open(title: string, options: Action[]) {
		menu = { title, options };
		selected = options.length === 1 ? options[0] : null;
		actionError = '';
		receipt = '';
	}
	function close() {
		menu = null;
		selected = null;
		actionError = '';
	}
	function backFromAction() {
		if (selected && menu && menu.options.length > 1) selected = null;
		else close();
	}
	async function confirm() {
		if (!selected || sending) return;
		sending = true;
		actionError = '';
		try {
			const answer = await selected.run();
			if (!mounted) return;
			receipt = answer;
			close();
			await refresh();
		} catch (cause) {
			if (mounted) {
				close();
				actionError = errorMessage(cause);
				await refresh();
			}
		} finally {
			sending = false;
		}
	}
	onMount(() => {
		void profile();
		void refresh();
		const visible = () => {
			if (!document.hidden && !busy && !menu && !reviewing && !held) void refresh();
		};
		const timer = setInterval(visible, 15000);
		document.addEventListener('visibilitychange', visible);
		return () => {
			mounted = false;
			read?.abort();
			version++;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', visible);
		};
	});
</script>

<div class="heading">
	<h1 class="screen-title">{uiText('Requests')}</h1>
	<button
		class="icon-button"
		aria-label={'Refresh ' + view}
		disabled={busy}
		onclick={() => {
			void refresh();
			if (profileError) void profile();
		}}><RefreshCw size={20} /></button
	>
</div>
<div
	class="settings-tabs request-tabs"
	data-surface="panel"
	role="tablist"
	aria-label={uiText('Request views')}
>
	{#each tabs as tab, i (tab.id)}
		<button
			role="tab"
			id={'requests-tab-' + tab.id}
			aria-selected={view === tab.id}
			aria-controls="requests-panel"
			tabindex={view === tab.id ? 0 : -1}
			onkeydown={(e) => tabKey(e, i)}
			onclick={() => switchView(tab.id)}>{uiText(tab.label)}</button
		>
	{/each}
</div>
<div
	class="panel"
	id="requests-panel"
	role="tabpanel"
	tabindex="0"
	aria-labelledby={'requests-tab-' + view}
>
	{#if profileError}<p role="alert">
			{uiText('Could not load account permissions.')}
			{profileError}
		</p>{/if}
	{#if error}<p role="alert">{error}</p>{/if}
	{#if actionError}<p role="alert">{actionError}</p>{/if}
	{#if receipt}<p role="status">{receipt}</p>{/if}

	{#snippet progress(title: string, value: number)}
		{@const percent = Math.min(100, Math.max(0, Math.round(value)))}
		<div class="progress">
			<progress aria-label={'Download progress for ' + title} value={percent} max="100"
			></progress><span>{percent}%</span>
		</div>
	{/snippet}
	{#snippet rows(items: RequestItem[], list: 'active' | 'history' | 'approvals')}
		<ul class="record-list" data-part="request-list">
			{#each items as r (r.request_kind + r.musicbrainz_id)}
				{@const album = requestedAlbum(r)}
				{@const title = r.track_title || r.album_title}
				{@const options = requestActions(session, viewer, r, list === 'approvals')}
				<RequestRecord
					{session}
					{title}
					artist={r.artist_name}
					kind={r.request_kind}
					art={album?.art}
					state={r.waiting_reason || r.task_state || r.status}
					label={statusLabel(r)}
					onopen={album ? () => onopen(album) : undefined}
					onactions={options.length ? () => open(title, options) : undefined}
				>
					{#if r.progress != null && r.status === 'downloading'}{@render progress(
							title,
							r.progress
						)}{/if}
					{#if list === 'approvals' && r.requested_by_name}<span
							>{uiText('Requested by')} {r.requested_by_name}</span
						>{/if}
					{#if list === 'history' && (r.completed_at || r.requested_at)}
						{@const time = new Date((r.completed_at || r.requested_at) * 1000)}
						<span
							>{r.completed_at ? uiText('Finished') : uiText('Requested')}
							<time datetime={time.toISOString()}
								>{time.toLocaleDateString(undefined, {
									year: 'numeric',
									month: 'short',
									day: 'numeric'
								})}</time
							></span
						>
					{/if}
					{#if r.error_message}<p class="reason">{r.error_message}</p>{/if}
				</RequestRecord>
			{/each}
		</ul>
	{/snippet}

	{#if view === 'requests'}
		<details class="settings-disclosure" data-surface="panel" bind:open={watchesOpen}>
			<summary><Eye size={19} aria-hidden="true" /><span>{uiText('Wanted watches')}</span></summary>
			{#if watchesOpen}<WantedWatches
					{session}
					{viewer}
					{onopen}
					onaction={open}
					ondownloads={() => switchView('downloads')}
					{launchWeb}
				/>{/if}
		</details>
		{#if active.length}<section aria-label={uiText('Active requests')}>
				<h2 class="section-title">{uiText('Active')} <span>{active.length}</span></h2>
				{@render rows(active, 'active')}
			</section>{/if}
		{#if history.length || historyStatus || historySort || active.length || historyTotal}
			<section aria-label={uiText('Request history')}>
				<h2 class="section-title">{uiText('History')} <span>{historyTotal}</span></h2>
				<details class="settings-disclosure filters" data-surface="panel">
					<summary
						><ListFilter size={18} aria-hidden="true" /><span
							>{uiText('Filter and sort history')}</span
						>{#if historyStatus || historySort}<Check
								size={15}
								aria-label={uiText('Filters applied')}
							/>{/if}</summary
					>
					<div>
						<label
							>{uiText('History status')}<InlineChoice selected={historyStatus}
								><select
									value={historyStatus}
									onchange={(event) => {
										historyStatus = event.currentTarget.value;
										updateHistory();
									}}
								>
									<option value="">{uiText('All statuses')}</option><option value="imported"
										>{uiText('Imported')}</option
									><option value="incomplete">{uiText('Incomplete')}</option><option value="failed"
										>{uiText('Failed')}</option
									><option value="cancelled">{uiText('Cancelled')}</option><option value="rejected"
										>{uiText('Rejected')}</option
									>
									{#if viewer?.role === 'admin'}<option value="reimportable"
											>{uiText('Can reimport')}</option
										>{/if}
								</select></InlineChoice
							></label
						>
						<label
							>{uiText('History order')}<InlineChoice selected={historySort}
								><select
									value={historySort}
									onchange={(event) => {
										historySort = event.currentTarget.value;
										updateHistory();
									}}
								>
									<option value="">{uiText('Newest first')}</option><option value="oldest"
										>{uiText('Oldest first')}</option
									><option value="status">{uiText('By status')}</option>
								</select></InlineChoice
							></label
						>
					</div>
				</details>
				{#if history.length}{@render rows(history, 'history')}
				{:else if !busy && !error}<p>
						{historyStatus
							? uiText('No requests match this status.')
							: uiText('No request history yet.')}
					</p>{/if}
			</section>
		{/if}
		{#if pages > 1}
			<div class="pagination">
				<button class="secondary" disabled={busy || page < 2} onclick={() => refresh(page - 1)}
					>{uiText('Previous')}</button
				>
				<span>{page} / {pages}</span><button
					class="secondary"
					disabled={busy || page >= pages}
					onclick={() => refresh(page + 1)}>{uiText('Next')}</button
				>
			</div>
		{/if}
		{#if !active.length && !history.length && !historyStatus && !historySort && !error}<p
				role="status"
			>
				{busy ? uiText('Loading requests…') : uiText('No requests yet.')}
			</p>{/if}
	{:else if view === 'approvals'}
		<section aria-label={uiText('Approvals')}>
			<h2 class="section-title">
				{uiText('Awaiting approval')} <span>{pending.length + batches.length}</span>
			</h2>
			{#each batches as card (card.id)}<PlaylistApprovalCard
					{session}
					{card}
					onreview={(action) => open(card.name, [action])}
				/>{/each}
			{#if pending.length}{@render rows(pending, 'approvals')}
			{:else if !batches.length && !error}<p role="status">
					{busy ? uiText('Loading approvals…') : uiText('No requests awaiting approval.')}
				</p>{/if}
		</section>
	{:else}
		{#if viewer}
			<div class="settings-list" data-surface="panel">
				<button class="settings-entry" onclick={() => (held = {})}>
					<FolderSearch size={19} aria-hidden="true" /><span>{uiText('Review all held files')}</span
					><ChevronRight size={17} aria-hidden="true" />
				</button>
			</div>
		{/if}
		{#each downloadSections as [group, entries] (group)}
			{@const visible = shown[group] ?? (group === 'Queued' ? 5 : 20)}
			<section aria-label={uiText(group)}>
				<h2 class="section-title">{uiText(group)} <span>{entries.length}</span></h2>
				<ul class="record-list">
					{#each entries.slice(0, visible) as task (task.id)}
						{@const title = task.track_title || task.album_title}
						{@const state = taskState(task)}
						{@const row = downloadRow(task, title)}
						<RequestRecord
							{session}
							{title}
							artist={task.artist_name}
							kind={task.download_type}
							art={cover(task.release_group_mbid)}
							{state}
							label={row.label ??
								state.charAt(0).toUpperCase() + state.slice(1).replaceAll('_', ' ')}
							onopen={row.open}
							openLabel={row.label ? row.label + ' for ' + title : undefined}
							onactions={row.actions}
							download
						>
							{#if task.status === 'downloading'}
								{@render progress(title, task.progress_percent)}
								{#if task.files_total > 0}<span
										>{task.files_completed}
										{uiText('of')}
										{task.files_total}
										{uiText('files')}</span
									>{/if}
							{/if}
							{#if task.reason?.text}<p class="reason">{task.reason.text}</p>{/if}
							{#if task.next_retry_at && task.retry_max > 0 && !task.held_for_review}
								<span
									>{uiText('Next retry')}
									{new Date(task.next_retry_at * 1000).toLocaleString()}</span
								>
							{/if}
						</RequestRecord>
					{/each}
				</ul>
				{#if entries.length > visible}
					<button class="text-button" onclick={() => (shown[group] = visible + 20)}
						>{uiText('Show more')} {group.toLowerCase()} ({entries.length - visible})</button
					>
				{/if}
			</section>
		{/each}
		{#if !tasks.length && !error}<p role="status">
				{busy ? uiText('Loading downloads…') : uiText('No downloads on this page.')}
			</p>{/if}
		{#if downloadPage > 1 || moreDownloads}
			<div class="pagination" aria-label={uiText('Download history pages')}>
				<button
					class="secondary"
					disabled={busy || downloadPage < 2}
					onclick={() => refresh(downloadPage - 1)}>{uiText('Previous')}</button
				>
				<span>{uiText('History page')} {downloadPage}</span><button
					class="secondary"
					disabled={busy || !moreDownloads}
					onclick={() => refresh(downloadPage + 1)}>{uiText('Next')}</button
				>
			</div>
		{/if}
		<details class="settings-disclosure server-tools" data-surface="panel">
			<summary
				><ExternalLink size={18} aria-hidden="true" /><span>{uiText('More on your server')}</span
				></summary
			>
			<p>{uiText('These tools open DroppedNeedle in your browser. Sign in there if prompted.')}</p>
			{#each serverTools as tool (tool.label)}
				<a
					class="settings-entry"
					href={session.serverUrl + tool.route}
					target="_blank"
					rel="noopener noreferrer"
					onclick={launchWeb}
				>
					<span>{uiText(tool.label)}</span><ExternalLink size={16} aria-hidden="true" />
				</a>
			{/each}
		</details>
	{/if}
</div>
{#if held && viewer}
	<HeldReview
		{session}
		{viewer}
		taskId={held.taskId}
		title={held.title}
		onclose={() => {
			held = null;
			void refresh();
		}}
	/>
{/if}
{#if reviewing}
	<RequestCandidates
		{session}
		jobId={reviewing.jobId}
		title={reviewing.title}
		onclose={closeReview}
		ondone={(message) => {
			closeReview(true);
			receipt = message;
			actionError = '';
			void refresh();
		}}
	/>
{/if}
{#if menu}
	<PlayerSheet
		title={selected?.label ?? menu.title}
		context={selected && selected.label !== menu.title ? menu.title : ''}
		backLabel={selected && menu.options.length > 1 ? 'Back to actions' : undefined}
		closeLabel={selected ? 'Close confirmation' : 'Close actions'}
		onclose={backFromAction}
		busy={sending}
	>
		{#if selected}
			<p class="effect">{selected.effect}</p>
			<div class="settings-actions">
				<button class="secondary" disabled={sending} onclick={backFromAction}
					>{uiText('Go back')}</button
				>
				<button class="primary" disabled={sending} onclick={confirm}
					>{uiText(selected.label)}</button
				>
			</div>
		{:else}
			<div class="choices">
				{#each menu.options as option (option.label)}
					<button class="settings-entry" onclick={() => (selected = option)}>
						<span>{uiText(option.label)}</span><ChevronRight size={17} aria-hidden="true" />
					</button>
				{/each}
			</div>
		{/if}
	</PlayerSheet>
{/if}

<style>
	.heading,
	.pagination,
	.section-title,
	.progress {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
	}
	.heading {
		margin: 0.35rem 0 1.2rem;
		flex-wrap: wrap;
	}
	.heading .screen-title {
		margin: 0;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.heading button {
		margin-inline-start: auto;
	}
	.request-tabs {
		display: flex;
		flex-wrap: wrap;
	}
	.request-tabs button {
		flex: 1 1 max-content;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.request-tabs button[aria-selected='true'] {
		font-weight: 720;
	}
	.panel {
		display: grid;
		min-width: 0;
		gap: 1.25rem;
		margin-top: 0.9rem;
	}
	.panel > *,
	.filters label {
		min-width: 0;
	}
	.panel p,
	.effect {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.panel .section-title {
		margin: 0 0 0.45rem;
		color: var(--heading);
	}
	.section-title span,
	.progress span,
	.pagination span {
		color: var(--muted);
		font-size: 0.85rem;
		font-weight: 550;
		font-variant-numeric: tabular-nums;
	}
	.section-title span {
		margin-inline-end: 0.35rem;
	}
	.record-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.pagination {
		flex-wrap: wrap;
	}
	.progress {
		gap: 0.55rem;
	}
	progress {
		flex: 1;
		min-width: 0;
		height: 0.4rem;
		accent-color: var(--accent);
	}
	.panel .reason {
		color: var(--text);
	}
	.settings-disclosure > summary span {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.settings-disclosure > summary::after {
		flex-shrink: 0;
	}
	.filters > div {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 8rem), 1fr));
		align-items: start;
		gap: 0.6rem;
	}
	.filters label {
		display: grid;
		gap: 0.25rem;
		font-size: 0.88rem;
	}
	.filters select {
		width: 100%;
		min-height: 44px;
	}
	.server-tools p {
		margin-bottom: 0.5rem;
		font-size: 0.9rem;
	}
	.server-tools a,
	.choices button {
		padding-inline: 0;
		border-top: 1px solid var(--line);
	}
	.choices button:first-child {
		border-top: 0;
	}
	.effect {
		margin-bottom: 0.85rem;
	}
</style>
