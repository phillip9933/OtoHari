<script lang="ts">
	import { observePick, reportPick } from './discoverInteractions';
	import PreviewItem from '../boards/PreviewItem.svelte';
	import type { Preview } from '../boards/display';
	import type { Session } from '../connection';
	import type { Album, OnPlay } from './catalog';
	import type { DiscoverArtistRef } from './discovery';
	import type { ShelfSong, WidgetResult } from './discoveryWidgets';
	import LibraryRadio from './LibraryRadio.svelte';
	let {
		active = false,
		display,
		data,
		session,
		onopen,
		onartist,
		onplay,
		onplaysong,
		ongenre
	}: {
		active?: boolean;
		display: Preview;
		data: WidgetResult;
		session: Session;
		onopen: (album: Album) => void;
		onartist: (artist: DiscoverArtistRef) => void;
		onplay: OnPlay;
		onplaysong: (song: ShelfSong) => void;
		ongenre?: (name: string) => void;
	} = $props();

	type Entry = {
		title: string;
		subtitle?: string;
		detail?: string;
		art?: string;
		fallbackArt?: string;
		seed?: string;
		label?: string;
		part?: string;
		action?: () => void;
		pick?: string;
		concertArtist?: DiscoverArtistRef;
		radio?: { kind: 'artist' | 'album' | 'genre'; id: string };
	};
	const items = $derived.by(() => {
		const slots: Entry[] = [];
		const reasons = new Map(data.cards?.map((c) => [c.album.localId || c.album.group, c.reason]));
		for (const shelf of data.shelves) {
			const detail = data.shelves.length > 1 ? shelf.title : undefined;
			if (shelf.radio)
				slots.push({
					title: shelf.title || 'Radio station',
					detail: shelf.note || undefined,
					radio: shelf.radio
				});
			else if (shelf.note) slots.push({ title: shelf.note, detail });
			for (const a of shelf.albums)
				slots.push({
					title: a.title,
					subtitle: a.artist,
					detail: reasons.get(a.localId || a.group) || detail,
					art: a.art,
					seed: a.group || a.localId || a.title,
					part: 'album-card',
					pick: data.cards ? (a.group ?? undefined) : undefined,
					action: () => {
						if (data.cards) void reportPick(session, a.group, 'opened');
						onopen(a);
					}
				});
			for (const a of shelf.artists) {
				const target = a.target;
				slots.push({
					title: a.name,
					detail,
					art: a.art,
					fallbackArt: a.fallbackArt,
					seed: target?.id || a.name,
					action: target ? () => onartist(target) : undefined
				});
			}
			for (const song of shelf.songs)
				slots.push({
					title: song.title,
					subtitle: song.artist,
					detail,
					action: () => onplaysong(song),
					label: 'Play ' + song.title
				});
			for (const genre of shelf.genres)
				slots.push({ title: genre, detail, action: ongenre ? () => ongenre?.(genre) : undefined });
			for (const text of shelf.unlinked) slots.push({ title: text, detail });
			if (slots.length >= display.limit) break;
		}
		for (const c of data.concerts ?? []) {
			const venue = [c.venue_name, c.city || c.matched_city, c.country_code]
				.filter(Boolean)
				.join(' · ');
			slots.push({
				title: c.event_name,
				subtitle: c.local_date,
				detail: [
					venue,
					c.status === 'cancelled' ? 'Cancelled' : c.status === 'rescheduled' ? 'Rescheduled' : ''
				]
					.filter(Boolean)
					.join(' · '),
				concertArtist: { id: c.artist_mbid, name: c.artist_name }
			});
		}
		return slots.slice(0, display.limit);
	});
</script>

<div class="preview-items">
	{#each items as item, i (i)}
		<PreviewItem
			{session}
			title={item.title}
			subtitle={item.subtitle}
			detail={item.detail}
			artwork={item.art}
			fallbackArt={item.fallbackArt}
			coverSeed={item.seed}
			onclick={item.action}
			label={item.label}
			part={item.part}
			observe={observePick(session, item.pick, active)}
		>
			{#snippet actions()}{#if item.concertArtist}{@const artist = item.concertArtist}<button
						class="text-button"
						onclick={() => onartist(artist)}>{artist.name}</button
					>{:else if item.radio}<LibraryRadio
						{session}
						seedType={item.radio.kind}
						seedId={item.radio.id}
						seedTitle={item.title}
						{onplay}
					/>{/if}{/snippet}
		</PreviewItem>
	{/each}
</div>
