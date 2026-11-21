<script lang="ts">
	import { Capacitor } from '@capacitor/core';
	import { tr, uiText } from '../i18n';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { getJson, type Session } from '../connection';
	import { path } from '../catalog/catalog';
	import { playlists } from '../catalog/playlists';
	import { rememberedPlaylistNames } from '../catalog/playlistOffline';
	import { filterPin } from './collectionPins';
	import { savedSections } from '../boards/layout';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { playlistId, type OfflineOptions, type OfflinePin } from './tracks';
	let {
		session,
		options,
		online,
		onpins
	}: {
		session: Session;
		options: OfflineOptions;
		online: boolean;
		onpins: (pins: OfflinePin[]) => Promise<void>;
	} = $props();
	let kind = $state<OfflinePin['kind']>('playlist'),
		query = $state(''),
		choosing = $state(false);
	let candidates = $state.raw<OfflinePin[]>([]),
		loading = $state(false),
		error = $state('');
	function stored(): OfflinePin[] {
		const list: OfflinePin[] = [...(options.offlinePins ?? [])];
		const legacy = options.autoDownload;
		if (legacy === 'recent' || legacy === 'favorites')
			list.unshift({
				kind: legacy,
				id: legacy,
				name: legacy === 'recent' ? 'Recently added songs' : 'Favorite songs'
			});
		const id = playlistId(legacy);
		if (id)
			list.unshift({
				kind: 'playlist',
				id,
				name:
					rememberedPlaylistNames(session).find((p) => p.id === id)?.name ?? 'Selected DN playlist'
			});
		return list;
	}
	const pins = $derived(stored());
	const same = (a: OfflinePin, b: OfflinePin) => a.kind === b.kind && a.id === b.id;
	$effect(() => {
		const selected = kind,
			text = query.trim(),
			owner = session;
		if (!choosing) return;
		const abort = new AbortController();
		candidates = [];
		error = '';
		loading = false;
		if (selected === 'filter')
			candidates = savedSections(owner.serverUrl, owner.userId ?? '').map(filterPin);
		else if (selected === 'recent' || selected === 'favorites')
			candidates = [
				{
					kind: selected,
					id: selected,
					name: selected === 'recent' ? 'Recently added songs' : 'Favorite songs'
				}
			];
		else if (selected === 'playlist' || selected === 'artist') {
			if (selected === 'playlist')
				candidates = rememberedPlaylistNames(owner).map((p) => ({ ...p, kind: 'playlist' }));
			if (online) {
				loading = true;
				const timer = setTimeout(
					async () => {
						try {
							const items =
								selected === 'playlist'
									? await playlists(owner, abort.signal)
									: (
											await getJson<components['schemas']['ArtistPage']>(
												owner,
												path(
													'/api/v3/library/artists',
													{},
													{ q: text || undefined, sort: 'name', order: 'asc', limit: 30 }
												),
												abort.signal
											)
										).items;
							if (!abort.signal.aborted)
								candidates = items.map((p) => ({ kind: selected, id: p.id, name: p.name }));
						} catch {
							if (!abort.signal.aborted) error = 'Could not load collections from DN.';
						} finally {
							if (!abort.signal.aborted) loading = false;
						}
					},
					selected === 'artist' && text ? 250 : 0
				);
				return () => {
					clearTimeout(timer);
					abort.abort();
				};
			}
		}
		return () => abort.abort();
	});
	async function add(pin: OfflinePin) {
		if (pins.some((p) => same(p, pin))) return;
		choosing = false;
		query = '';
		await onpins([...pins, pin]);
	}
</script>

{#each pins as pin (pin.kind + '/' + pin.id)}
	<div class="pin">
		<span
			>{pin.name}<small
				>{{
					playlist: 'DN playlist',
					artist: 'Artist',
					filter: 'Saved library filter',
					recent: 'Latest 25 songs',
					favorites: 'Latest 25 favorites'
				}[pin.kind]}</small
			></span
		>
		<button
			class="text-button"
			aria-label={tr(`Stop keeping ${pin.name} offline`, `${pin.name} の自動保存を停止`)}
			onclick={() => onpins(pins.filter((p) => !same(p, pin)))}
			>{tr('Stop keeping offline', '自動保存を停止')}</button
		>
	</div>
{/each}
{#if choosing}
	<label
		>{uiText('Collection type')}<InlineChoice selected={kind}
			><select bind:value={kind} onchange={() => (query = '')}>
				<option value="playlist">{uiText('DN playlist')}</option><option value="artist"
					>{uiText('Artist')}</option
				><option value="filter">{uiText('Saved library filter')}</option>
				<option value="recent">{uiText('Recently added songs')}</option><option value="favorites"
					>{uiText('Favorite songs')}</option
				>
			</select></InlineChoice
		></label
	>
	{#if kind === 'artist'}<label
			>{uiText('Find an artist')}<input
				type="search"
				bind:value={query}
				placeholder={uiText('Artist name')}
			/></label
		>{/if}
	{#if loading}<p role="status">{uiText('Loading collections…')}</p>{/if}
	{#if error}<p role="status">{error}</p>{/if}
	{#each candidates.filter((p) => !pins.some((pin) => same(pin, p))) as item (item.id)}
		<button class="text-button" onclick={() => add(item)}
			>{tr(`Keep ${item.name} offline`, `${item.name} をオフラインで保存`)}</button
		>
	{:else}
		{#if !loading && !error}<p>
				{kind === 'filter'
					? uiText('No more saved library filters. Create one in Library customization.')
					: uiText('No more matching collections.')}
			</p>{/if}
	{/each}
	<button class="secondary" onclick={() => (choosing = false)}>{uiText('Done')}</button>
{:else}
	<button id="keep-collection-offline" class="secondary" onclick={() => (choosing = true)}
		>{tr('Keep a collection offline', 'コレクションをオフラインで保存')}</button
	>
{/if}
<p>
	{Capacitor.getPlatform() === 'ios'
		? tr(
				'Your iPhone checks these collections when you return to the app on an allowed network. Shared songs use one copy. Removing a collection deletes its automatic downloads unless another collection still needs them.',
				'許可されたネットワークでアプリに戻るとコレクションを更新します。自動保存を停止すると、他のコレクションでも使用している曲を除き、自動ダウンロードが削除されます。'
			)
		: tr(
				'Android checks these collections about every six hours on allowed networks. Shared songs use one copy. Removing a collection deletes its automatic downloads unless another collection still needs them.',
				'Android は許可されたネットワークで約6時間ごとに更新します。自動保存を停止すると、他のコレクションでも使用している曲を除き、自動ダウンロードが削除されます。'
			)}
</p>

<style>
	.pin {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
	}
	.pin small {
		display: block;
		color: var(--muted);
	}
</style>
