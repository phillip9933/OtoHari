<script lang="ts">
	import { uiText, uiFormat, tr } from '../i18n';

	import { onMount } from 'svelte';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import WebPaletteImport from './WebPaletteImport.svelte';
	import { Check } from '@lucide/svelte';
	import { getJson, putJson, type Session } from '../connection';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import {
		asTheme,
		albumSheetColor,
		artworkColorScope,
		saveArtworkScope,
		isMode,
		labels,
		presets,
		readTheme,
		restoreTheme,
		savedCustom,
		saveTheme,
		type Mode,
		type Selection,
		type Theme
	} from './theme';
	type Appearance = components['schemas']['MyAppearance'];
	let { session = null }: { session?: Session | null } = $props();
	const modes = ['dark', 'light', 'midnight', 'system'] as const;
	const initial = restoreTheme();
	let selected = $state<Selection>(initial),
		draft = $state(JSON.stringify(asTheme(initial), null, 2)),
		lastCustom = $state(savedCustom());
	let feedback = $state(''),
		error = $state(''),
		matchesLight = $state(false);
	let currentCss = $state('');
	let account = $state<Mode | null | undefined>(undefined),
		accountError = $state(''),
		accountMessage = $state(''),
		saving = $state(false),
		retry = $state(0);
	let version = 0;
	onMount(() => {
		const media = matchMedia('(prefers-color-scheme: light)');
		matchesLight = media.matches;
		const update = () => {
			matchesLight = media.matches;
			if (selected.mode === 'system') draft = JSON.stringify(asTheme(selected), null, 2);
		};
		media.addEventListener('change', update);
		return () => media.removeEventListener('change', update);
	});
	function choose(value: Selection) {
		try {
			saveTheme(value);
			selected = value;
			draft = JSON.stringify(asTheme(value), null, 2);
			if (value.mode === 'custom') lastCustom = value.theme;
			feedback = `Applied ${value.mode === 'custom' ? value.theme.name : labels[value.mode]}.`;
			error = '';
			accountMessage = '';
		} catch (cause) {
			feedback = '';
			error = cause instanceof Error ? cause.message : 'Could not save this theme.';
		}
	}
	function importTheme() {
		let theme: Theme;
		try {
			theme = readTheme(draft);
		} catch (cause) {
			feedback = '';
			error =
				cause instanceof SyntaxError
					? 'Enter valid JSON.'
					: cause instanceof Error
						? cause.message
						: 'Could not read this theme.';
			return;
		}
		choose({ mode: 'custom', theme });
	}
	$effect(() => {
		const active = session;
		void retry;
		const request = ++version;
		account = undefined;
		currentCss = '';
		accountError = accountMessage = '';
		saving = false;
		if (active)
			void getJson<Appearance>(active, '/api/v3/me/appearance')
				.then((result) => {
					if (version !== request) return;
					if (result.theme != null && !isMode(result.theme))
						throw Error('This account uses a theme this version cannot display.');
					account = result.theme ?? null;
					currentCss = result.custom_css?.text ?? '';
				})
				.catch((cause) => {
					if (version === request)
						accountError =
							cause instanceof Error ? cause.message : 'Could not load the account theme.';
				});
		return () => {
			version++;
		};
	});
	async function saveAccount() {
		if (!session || saving || selected.mode === 'custom') return;
		const owner = version,
			mode = selected.mode;
		saving = true;
		accountError = accountMessage = '';
		try {
			const updated = await putJson<Appearance>(session, '/api/v3/me/appearance', {
				theme: mode
			} satisfies components['schemas']['AppearanceUpdate']);
			if (version === owner) {
				account = updated.theme ?? null;
				currentCss = updated.custom_css?.text ?? '';
				accountMessage = 'Account theme saved.';
			}
		} catch (cause) {
			if (version === owner)
				accountError = cause instanceof Error ? cause.message : 'Could not save the account theme.';
		} finally {
			if (version === owner) saving = false;
		}
	}
</script>

<section class="settings-stack" data-part="theme-settings" aria-label={uiText('Theme settings')}>
	<h2>{uiText('Device theme')}</h2>
	<div class="modes" role="group" aria-label={uiText('Device theme')}>
		{#each modes as mode (mode)}{@const resolved =
				mode === 'system' ? (matchesLight ? 'light' : 'dark') : mode}
			{@const palette = asTheme({ mode: resolved })}
			<button
				class="choice"
				aria-label={uiText(labels[mode])}
				aria-pressed={selected.mode === mode}
				onclick={() => choose({ mode })}
				><span
					class="swatch"
					style:background={palette.colors.bg}
					style:color={palette.colors.accent}
					style:border-block-end-color={albumSheetColor(resolved)}
					aria-hidden="true">Aa</span
				>{uiText(labels[mode])}{#if selected.mode === mode}<Check
						size={16}
						aria-hidden="true"
					/>{/if}</button
			>
		{/each}
	</div>
	{#if selected.mode === 'dark' || selected.mode === 'midnight'}<p>
			{tr(
				'Dark uses cream album track lists. Midnight uses dark green track lists. Both use the same lime accent.',
				'ダークではアルバムの曲一覧がクリーム色、ミッドナイトでは深緑になります。アクセントはどちらもライム色です。'
			)}
		</p>{/if}
	{#if selected.mode === 'system'}<p>
			{uiFormat('Following this device’s {mode} setting.', {
				mode: uiText(matchesLight ? 'light' : 'dark')
			})}
		</p>{/if}
	{#if selected.mode === 'custom'}<p>
			{uiText('Using custom theme')} <strong>{selected.theme.name}</strong>.
		</p>{:else if lastCustom}<button
			class="text-button"
			onclick={() => {
				if (lastCustom) choose({ mode: 'custom', theme: lastCustom });
			}}>{uiText('Use custom theme')} {lastCustom.name}</button
		>{/if}
	<label id="theme-artwork" class="artwork-setting">
		<span>{uiText('Album artwork colors')}</span>
		<InlineChoice selected={$artworkColorScope} label={uiText('Album artwork colors')}
			><select
				aria-label={uiText('Album artwork colors')}
				value={$artworkColorScope}
				onchange={(e) => saveArtworkScope(e.currentTarget.value)}
			>
				<option value="off">{uiText('Off')}</option>
				<option value="player">{uiText('Now Playing only')}</option>
				<option value="app">{uiText('Entire app')}</option>
			</select></InlineChoice
		>
	</label>
	<details id="theme-sharing" class="settings-disclosure" data-surface="panel">
		<summary>{uiText('Edit or share theme')}</summary>
		<p>
			{uiText(
				'Copy the JSON to share your colors, spacing and typeface. Paste a theme here to use it on this device.'
			)}
		</p>
		<label for="theme-json">{uiText('Theme JSON')}</label><textarea
			id="theme-json"
			rows="8"
			spellcheck="false"
			bind:value={draft}
		></textarea><button class="secondary" onclick={importTheme}>{uiText('Apply theme')}</button>
		<div class="legacy" role="group" aria-label={uiText('Original mobile themes')}>
			{#each presets as theme (theme.name)}<button
					class="text-button"
					onclick={() => choose({ mode: 'custom', theme })}>{theme.name}</button
				>{/each}
		</div>
	</details>
	{#if feedback}<p role="status">{feedback}</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
	{#if session}<h2>{uiText('DroppedNeedle account')}</h2>
		{#if account !== undefined}<p>
				{account
					? 'Account theme: ' + labels[account] + '.'
					: uiText('Your account uses the default Dark theme.')}
			</p>
			<div class="account-tools">
				<button
					class="secondary"
					disabled={saving || selected.mode === (account || 'dark')}
					onclick={() => choose({ mode: account ?? 'dark' })}
					>{uiText('Use account theme on this device')}</button
				>
				{#if selected.mode !== 'custom'}<button
						class="secondary"
						disabled={saving || selected.mode === account}
						onclick={saveAccount}>{uiText('Save device theme to account')}</button
					>{:else}<p>
						{uiText(
							'Custom theme JSON is stored on this device. Choose a built-in theme to save it to your account.'
						)}
					</p>{/if}
			</div>
			<WebPaletteImport
				{session}
				css={currentCss}
				mode={account ?? 'dark'}
				onapply={(theme) => choose({ mode: 'custom', theme })}
			/>{:else if !accountError}<p role="status">{uiText('Loading account theme…')}</p>{/if}
		{#if accountError}<p role="alert">{accountError}</p>
			<button class="text-button" disabled={saving} onclick={() => retry++}
				>{uiText('Reload account theme')}</button
			>{/if}
		{#if accountMessage}<p role="status">{accountMessage}</p>{/if}
	{/if}
</section>

<style>
	.modes {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 48px;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		text-align: left;
	}
	.choice[aria-pressed='true'] {
		border-color: var(--dn-focus);
		outline: 1px solid var(--dn-focus);
	}
	.swatch {
		border: 1px solid var(--line);
		border-block-end-width: 5px;
		border-radius: 0.25rem;
		font-weight: 700;
		padding: 0.18rem 0.32rem;
	}
	.choice :global(svg) {
		margin-inline-start: auto;
	}
	label,
	textarea {
		display: block;
	}
	label {
		margin-top: 0.6rem;
	}
	label.artwork-setting {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.4rem 1rem;
	}
	textarea {
		width: 100%;
		resize: vertical;
		margin-block: 0.35rem 0.6rem;
		font-family: ui-monospace, monospace;
	}
	.legacy,
	.account-tools {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.legacy {
		margin-top: 0.5rem;
	}
	section > p {
		color: var(--muted);
	}
</style>
