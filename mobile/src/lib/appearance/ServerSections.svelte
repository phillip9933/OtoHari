<script lang="ts">
	import { uiText } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { onMount } from 'svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import type { Session } from '../connection';
	import { getVisibility, saveVisibility } from '../boards/sectionVisibility';
	import { errorMessage } from '../catalog/catalog';
	type S = components['schemas'];
	let { session, admin }: { session: Session; admin: boolean } = $props();
	let page = $state<S['SectionPage']>('home'),
		data = $state<S['SectionPrefsResponse']>(),
		changes = $state<Record<string, boolean>>({}),
		busy = $state(false),
		error = $state(''),
		message = $state('');
	const pages = $derived(
		admin ? (['home', 'discover', 'sidebar'] as const) : (['home', 'discover'] as const)
	);
	const rows = $derived(data?.pages[page] ?? []);
	async function load() {
		busy = true;
		error = '';
		try {
			data = await getVisibility(session);
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		void load();
	});
	function toggle(row: S['SectionPrefItem']) {
		const next = { ...changes };
		if (row.key in next) delete next[row.key];
		else next[row.key] = !row.enabled;
		changes = next;
		message = '';
	}
	async function save() {
		if (busy) return;
		busy = true;
		error = message = '';
		try {
			data = await saveVisibility(session, page, changes);
			changes = {};
			message = 'Section preferences saved.';
		} catch (e) {
			error = errorMessage(e);
		} finally {
			busy = false;
		}
	}
</script>

<p>
	{uiText(
		'Choose the sections your DN account receives. These settings also apply to the web app.'
	)}
</p>
<label
	>{uiText('Page')}<InlineChoice selected={page}
		><select
			disabled={busy || !!Object.keys(changes).length}
			bind:value={page}
			onchange={() => (message = '')}
			>{#each pages as p (p)}<option value={p}>{p[0].toUpperCase() + p.slice(1)}</option
				>{/each}</select
		></InlineChoice
	></label
>
{#if data}
	{#if rows.length}<div class="settings-list" data-surface="panel">
			{#each rows as row (row.key)}<label class="choice"
					><input
						type="checkbox"
						checked={changes[row.key] ?? row.enabled}
						disabled={busy || !row.available}
						onchange={() => toggle(row)}
					/><span
						><strong>{row.title}</strong><small>{row.description}</small>{#if !row.available}<small
								>{row.turned_off
									? uiText('Disabled on this server.')
									: row.requires
										? 'Requires ' + row.requires + '.'
										: uiText('Unavailable on this server.')}</small
							>{/if}</span
					></label
				>{/each}
		</div>{/if}
	{#if !rows.length}<p>{uiText('No sections for this page.')}</p>{/if}
	<button class="secondary" disabled={busy || !Object.keys(changes).length} onclick={save}
		>{uiText('Save section preferences')}</button
	>
	{#if Object.keys(changes).length}<button
			class="text-button"
			disabled={busy}
			onclick={() => (changes = {})}>{uiText('Discard changes')}</button
		>{/if}
{:else if busy}<p role="status">{uiText('Loading section preferences…')}</p>{/if}
{#if error}<p role="alert">{error}</p>
	{#if !data}<button class="text-button" onclick={load}>{uiText('Try again')}</button>{/if}{/if}
{#if message}<p role="status">{message}</p>{/if}

<style>
	label {
		display: grid;
		gap: 0.3rem;
	}
	.choice {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		min-height: 48px;
		padding: 0.7rem var(--gap);
	}
	input {
		margin-top: 0.35rem;
		accent-color: var(--accent);
	}
	strong,
	small {
		display: block;
	}
	small {
		color: var(--muted);
	}
</style>
