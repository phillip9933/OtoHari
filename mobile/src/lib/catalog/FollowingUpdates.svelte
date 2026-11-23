<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
	import { getJson, putJson, postJson, type Session } from '../connection';
	import { tr } from '../i18n';
	import InlineChoice from '../controls/InlineChoice.svelte';
	import { path, errorMessage } from './catalog';

	type S = components['schemas'];
	type City = S['EventCity'];
	let {
		session,
		concerts,
		onchanged
	}: { session: Session; concerts: boolean; onchanged: () => void } = $props();
	const endpoint = path('/api/v3/following/concerts/cities');
	const alive = new AbortController();
	let seenError = $state(''),
		open = $state(false),
		cities = $state<City[] | null>(null);
	let query = $state(''),
		results = $state<S['CitySearchResult'][]>([]),
		searching = $state(false);
	let saving = $state(false),
		cityError = $state(''),
		searchError = $state(''),
		reload = $state(0);
	onDestroy(() => alive.abort());
	async function markSeen() {
		seenError = '';
		try {
			await postJson(
				session,
				path(concerts ? '/api/v3/following/concerts/seen' : '/api/v3/following/new-releases/seen'),
				undefined,
				alive.signal
			);
		} catch (cause) {
			if (!alive.signal.aborted) seenError = errorMessage(cause);
		}
	}
	onMount(() => {
		void markSeen();
	});

	$effect(() => {
		void reload;
		if (!open) return;
		const controller = new AbortController();
		cityError = '';
		cities = null;
		void getJson<S['EventCitiesResponse']>(session, endpoint, controller.signal).then(
			(reply) => {
				if (!controller.signal.aborted) cities = reply.items;
			},
			(cause) => {
				if (!controller.signal.aborted) cityError = errorMessage(cause);
			}
		);
		return () => controller.abort();
	});
	$effect(() => {
		const q = query.trim(),
			account = session;
		results = [];
		searchError = '';
		searching = open && q.length >= 2;
		if (!open || q.length < 2) return;
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const found = await getJson<S['CitySearchResponse']>(
					account,
					path('/api/v3/following/concerts/city-search', {}, { q }),
					controller.signal
				);
				if (!controller.signal.aborted) results = found.items;
			} catch (cause) {
				if (!controller.signal.aborted) searchError = errorMessage(cause);
			} finally {
				if (!controller.signal.aborted) searching = false;
			}
		}, 300);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	const sameCity = (a: City, b: City) => a.latitude === b.latitude && a.longitude === b.longitude;
	async function update(action: 'add' | 'remove' | 'resize', city: City) {
		if (saving || !cities) return;
		saving = true;
		cityError = '';
		try {
			// DN replaces the entire list. Apply this single edit to the latest server copy.
			const { items: latest } = await getJson<S['EventCitiesResponse']>(
				session,
				endpoint,
				alive.signal
			);
			let items: City[];
			if (action === 'add') {
				if (latest.some((c) => sameCity(c, city))) {
					cities = latest;
					query = '';
					return;
				}
				if (latest.length >= 50)
					throw Error(tr('You can save up to 50 cities.', '保存できる都市は50件までです。'));
				items = [...latest, city];
			} else if (action === 'remove') {
				items = latest.filter((c) => !sameCity(c, city));
			} else {
				items = latest.map((c) => (sameCity(c, city) ? { ...c, radius_km: city.radius_km } : c));
			}
			alive.signal.throwIfAborted();
			const saved = await putJson<S['EventCitiesResponse']>(session, endpoint, {
				items
			} satisfies S['EventCitiesUpdate']);
			if (!alive.signal.aborted) {
				cities = saved.items;
				if (action === 'add') query = '';
				onchanged();
			}
		} catch (cause) {
			if (!alive.signal.aborted) cityError = errorMessage(cause);
		} finally {
			saving = false;
		}
	}
	const radii = [16, 32, 80, 161];
</script>

{#if seenError}<p role="alert">
		{tr('Could not mark this list as seen.', '既読にできませんでした。')}
		<button class="text-button" onclick={markSeen}>{tr('Retry', '再試行')}</button>
	</p>{/if}
{#if concerts}
	<details bind:open>
		<summary>{tr('Concert cities', 'コンサートの都市')}</summary>
		{#if open}
			{#if cities}
				{#each cities as city (city.latitude + ':' + city.longitude)}
					<div class="city">
						<span>{city.city_name}</span>
						<InlineChoice
							label={tr('Concert radius for', '検索範囲：') + ' ' + city.city_name}
							selected={String(city.radius_km)}
							><select
								value={city.radius_km}
								disabled={saving}
								onchange={(e) =>
									void update('resize', { ...city, radius_km: Number(e.currentTarget.value) })}
							>
								{#each [...new Set( [...radii, city.radius_km] )].sort((a, b) => a - b) as radius (radius)}<option
										value={radius}>{radius} km</option
									>{/each}
							</select></InlineChoice
						>
						<button
							class="text-button"
							disabled={saving}
							aria-label={tr('Remove city', '都市を削除') + ' ' + city.city_name}
							onclick={() => update('remove', city)}>{tr('Remove', '削除')}</button
						>
					</div>
				{/each}
				<label
					>{tr('Find a city', '都市を検索')}<input
						type="search"
						bind:value={query}
						maxlength={100}
					/></label
				>
				{#if searching}<small>{tr('Searching…', '検索中…')}</small>{:else if searchError}<p
						role="alert"
					>
						{searchError}
					</p>{:else if query.trim().length >= 2 && results.length === 0}<small
						>{tr('No matching cities.', '該当する都市はありません。')}</small
					>{/if}
				{#each results as result (result.latitude + ':' + result.longitude)}
					<button
						class="secondary"
						disabled={saving}
						onclick={() =>
							update('add', {
								city_name: result.name,
								country_code: result.country_code,
								latitude: result.latitude,
								longitude: result.longitude,
								radius_km: 32
							})}
					>
						{[result.name, result.region, result.country].filter(Boolean).join(', ')}
					</button>
				{/each}
			{:else if !cityError}<small>{tr('Loading…', '読み込み中…')}</small>{/if}
			{#if cityError}<p role="alert">
					{cityError}
					<button class="text-button" onclick={() => reload++}
						>{tr('Reload cities', '都市を再読み込み')}</button
					>
				</p>{/if}
		{/if}
	</details>
{/if}

<style>
	details {
		margin-block: 0.75rem;
	}
	summary {
		min-height: 44px;
		align-content: center;
		cursor: pointer;
	}
	.city {
		display: flex;
		align-items: center;
		gap: var(--gap);
		flex-wrap: wrap;
	}
	label {
		display: grid;
		gap: 0.25rem;
		margin-block: 0.5rem;
	}
</style>
