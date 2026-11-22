<script lang="ts">
	import { uiText } from '../i18n';
	import type { Preview } from '../boards/display';
	import PreviewItem from '../boards/PreviewItem.svelte';
	import type { Session } from '../connection';
	import { errorMessage, type OnPlay } from './catalog';
	import { findListen, recentListens, recentPlayPreviews, type Listen } from './libraryWidgets';

	let {
		display,
		session,
		onplay,
		active = true
	}: {
		session: Session;
		display: Preview;
		onplay: OnPlay;
		active?: boolean;
	} = $props();
	let listens = $state<Listen[]>([]),
		refreshing = $state(false),
		disabled = $state(false),
		loading = $state(true),
		error = $state(''),
		retry = $state(0),
		notice = $state(''),
		resolving = $state<number | null>(null);
	const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	function playedAt(value?: string | null) {
		const ms = value ? Date.parse(value) : NaN;
		return Number.isFinite(ms) ? date.format(ms) : '';
	}
	let selection = 0;
	let unavailable = $state<Record<number, string>>({});
	$effect(() => {
		const account = session;
		void retry;
		if (!active) return;
		let valid = true,
			timer: ReturnType<typeof setTimeout>;
		async function load() {
			try {
				const result = await recentListens(account);
				if (!valid) return;
				recentPlayPreviews.set(account, result);
				listens = result.listens;
				refreshing = result.refreshing;
				disabled = result.disabled;
				if (result.refreshing && !result.listens.length) timer = setTimeout(load, 10_000);
			} catch (e) {
				if (valid) error = errorMessage(e);
			} finally {
				if (valid) loading = false;
			}
		}
		error = '';
		const preview = recentPlayPreviews.get(account);
		listens = preview?.listens ?? [];
		disabled = preview?.disabled ?? false;
		refreshing = preview?.refreshing ?? false;
		unavailable = {};
		loading = !preview;
		notice = '';
		resolving = null;
		void load();
		return () => {
			valid = false;
			selection++;
			clearTimeout(timer);
		};
	});
	async function play(listen: Listen, index: number) {
		const attempt = ++selection;
		notice = '';
		resolving = index;
		try {
			const track = await findListen(session, listen);
			if (attempt !== selection) return;
			if (typeof track === 'string') {
				listens.forEach((other, i) => {
					if (other.musicbrainz_id === listen.musicbrainz_id && other.title === listen.title)
						unavailable[i] = track;
				});
				notice = listen.title + ' · ' + track;
			} else await onplay([track], 0);
		} catch (e) {
			if (attempt === selection) notice = errorMessage(e);
		} finally {
			if (attempt === selection) resolving = null;
		}
	}
</script>

{#if error}
	<p role="alert">{error}</p>
	<button class="secondary" onclick={() => retry++}>{uiText('Try again')}</button>
{:else if listens.length}
	<ol data-part="recent-listens" class="preview-items">
		{#each listens.slice(0, display.limit) as listen, i (i)}
			<li>
				<PreviewItem
					{session}
					choice={listen.musicbrainz_id && !unavailable[i]
						? {
								id: 'listen:' + i + ':' + listen.listened_at + ':' + listen.musicbrainz_id,
								title: listen.title,
								tracks: async (signal) => {
									const track = await findListen(session, listen, signal);
									if (typeof track === 'string') throw Error(listen.title + ' · ' + track);
									return [track];
								}
							}
						: undefined}
					title={listen.title}
					subtitle={[listen.artist_name, listen.album_name].filter(Boolean).join(' · ')}
					detail={unavailable[i] || (!listen.musicbrainz_id ? 'Local copy unknown' : '')}
					time={listen.listened_at && playedAt(listen.listened_at)
						? { value: listen.listened_at, label: playedAt(listen.listened_at) }
						: undefined}
					onclick={listen.musicbrainz_id && !unavailable[i] ? () => play(listen, i) : undefined}
					label={'Replay ' + listen.title}
					disabled={resolving !== null}
				/>
			</li>
		{/each}
	</ol>
{:else if loading || refreshing}
	<p role="status">{uiText('Loading recent plays…')}</p>
{:else if disabled}<p>
		{uiText(
			'To see your recent plays, enable Recently Played under Settings → Account-wide content visibility → Home.'
		)}
	</p>
{:else}<p>{uiText('No recent plays available from DroppedNeedle.')}</p>{/if}
{#if resolving !== null}<p role="status">{uiText('Finding the local track…')}</p>{:else if notice}<p
		role="status"
	>
		{notice}
	</p>{/if}

<style>
	li {
		min-width: 0;
		display: grid;
	}
</style>
