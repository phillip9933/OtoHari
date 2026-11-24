<script lang="ts">
	import { tr, uiText } from '../i18n';
	import { Upload } from '@lucide/svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { postJson, type Session } from '../connection';
	import { errorMessage, path } from './catalog';
	import PlaylistDialog from './PlaylistDialog.svelte';
	type S = components['schemas'];
	let {
		session,
		onimport,
		compact = false
	}: { session: Session; onimport: () => void; compact?: boolean } = $props();
	let open = $state(false),
		file = $state<File>(),
		name = $state(''),
		busy = $state(false),
		error = $state('');
	type ImportReport = S['ImportPlaylistResponse'] & { kept?: number };
	let report = $state<ImportReport>();
	let libraryOnly = $state(false);
	const reasons: Record<S['ImportUnmatchedReason'], string> = {
		names_nothing: 'No filename',
		no_match: 'No matching local file',
		duplicate: 'Duplicate entry'
	};
	function pick(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		file = undefined;
		name = error = '';
		const choice = input.files?.[0];
		if (!choice) return;
		if (!/\.(csv|m3u8?)$/i.test(choice.name)) error = 'Choose an M3U, M3U8 or CSV file.';
		else if (choice.size > 2 * 1024 ** 2) error = 'Choose a file up to 2 MiB.';
		else {
			file = choice;
			name = choice.name.replace(/\.(csv|m3u8?)$/i, '').trim() || 'Imported playlist';
		}
	}
	async function submit() {
		if (!file || !name.trim() || busy || report) return;
		busy = true;
		error = '';
		try {
			const body: S['ImportPlaylistBody'] & { library_only?: boolean } = {
				name: name.trim(),
				format: /\.csv$/i.test(file.name) ? 'csv' : 'm3u8',
				content: await file.text(),
				...(libraryOnly ? { library_only: true } : {})
			};
			report = await postJson<ImportReport>(session, path('/api/v3/playlists/import'), body);
			onimport();
		} catch (cause) {
			error = errorMessage(cause);
		} finally {
			busy = false;
		}
	}
	function start() {
		file = report = undefined;
		libraryOnly = false;
		name = error = '';
		open = true;
	}
</script>

<button
	class="text-button"
	class:import-pill={compact}
	aria-label={uiText('Import playlist')}
	onclick={start}
	><Upload size={18} />{compact ? uiText('Import') : uiText('Import playlist')}</button
>
{#if open}
	<PlaylistDialog
		title={report ? 'Playlist imported' : uiText('Import playlist')}
		onclose={() => (open = false)}
		{busy}
	>
		{#if report}
			<p>
				<strong>{report.name}</strong> · {report.matched}
				{report.matched === 1 ? uiText('track') : uiText('tracks')}
				{uiText('added')}
			</p>
			{#if report.kept}<p>
					{tr(`Songs kept to request: ${report.kept}`, `リクエスト用に保存した曲：${report.kept}`)}
				</p>{/if}
			{#if report.unmatched.length}<details>
					<summary>{uiText('Unmatched entries (')}{report.unmatched.length})</summary>
					<ul>
						{#each report.unmatched.slice(0, 200) as row, i (i)}<li>
								<strong>{row.title || uiText('Untitled')}</strong>{row.artist
									? ' · ' + row.artist
									: ''} · {uiText(reasons[row.reason])}
							</li>{/each}
					</ul>
					{#if report.unmatched.length > 200}<p>{uiText('Showing the first 200 entries.')}</p>{/if}
				</details>{/if}
			{#if report.over_limit}<p>
					{report.over_limit}
					{uiText('entries exceeded DN’s 10,000-entry import limit.')}
				</p>{/if}
			<button class="secondary" onclick={() => (open = false)}>{uiText('Done')}</button>
		{:else}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<label
					>{uiText('Playlist file')}<input
						type="file"
						accept=".m3u,.m3u8,.csv"
						disabled={busy}
						onchange={pick}
					/></label
				>
				{#if file}<label
						>{uiText('Playlist name')}<input required bind:value={name} disabled={busy} /></label
					>{/if}
				<label class="library-only"
					><input type="checkbox" bind:checked={libraryOnly} disabled={busy} />{tr(
						'Only songs already in the library',
						'ライブラリにある曲だけを追加'
					)}</label
				>
				<p>
					{tr(
						'On supported servers, missing songs with a title and artist can be kept for later requests.',
						'対応するサーバーでは、ライブラリにない曲も曲名とアーティストがあれば、後でリクエストできるように保存します。'
					)}
				</p>
				{#if error}<p role="alert">{error}</p>{/if}
				<div class="actions">
					<button class="secondary" type="button" disabled={busy} onclick={() => (open = false)}
						>{uiText('Cancel')}</button
					><button class="primary" disabled={busy || !file || !name.trim()}
						>{busy ? uiText('Importing…') : uiText('Create from file')}</button
					>
				</div>
			</form>
		{/if}
	</PlaylistDialog>
{/if}

<style>
	.library-only {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.library-only input {
		width: auto;
	}
</style>
