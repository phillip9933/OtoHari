<script lang="ts">
	import { uiText, tr } from './lib/i18n';
	import { onMount, tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { Capacitor } from '@capacitor/core';
	import { App as NativeApp } from '@capacitor/app';
	import { widgetLinks } from './lib/player/widgetLinks';
	import { Menu } from '@lucide/svelte';
	import Navigation from './lib/Navigation.svelte';
	import {
		cancelScreenMotion,
		changeScreen,
		interfacePreferences,
		libraryDestinations,
		readStartScreen,
		type BrowseDestination,
		type Destination
	} from './lib/appearance/interface';
	import {
		offlineSupported,
		stopIPhoneDownloads,
		preferredOffline,
		runAutoDownloads,
		stopAutoDownloads
	} from './lib/offline/media';
	import OfflineLibrary from './lib/offline/OfflineLibrary.svelte';
	import { nativeMedia } from './lib/offline/nativeMedia';
	import { connectTrackFeedback } from './lib/offline/feedback';
	import Connect from './lib/auth/Connect.svelte';
	import {
		restoreSession,
		signOut,
		forgetSession,
		retrySignOuts,
		type Session
	} from './lib/connection';
	import type { LibraryContinuation } from './lib/player/libraryWindow';
	import { player, type PlayerTrack } from './lib/player';
	import { connectMobileDevice } from './lib/player/deviceLink';
	import PlayerView from './lib/PlayerView.svelte';
	import { PanelPull, type PlayerSurface } from './lib/player/panelPull.svelte';
	import {
		playerGestures,
		type PlayerGestureActions,
		type PullDirection
	} from './lib/player/playerGestures';
	import PlayerLibraryDetail from './lib/player/PlayerLibraryDetail.svelte';
	import {
		rememberQueueSource,
		restoredQueueSource,
		type Credit,
		type PlayerCredit,
		type SavedScope
	} from './lib/player/related';
	import { songLink } from './lib/catalog/songLinks';
	import Catalog from './lib/catalog/Catalog.svelte';
	import { setDetailSettings } from './lib/catalog/DetailSettings.svelte';
	import {
		launcherShortcuts,
		clearIPhonePlaylistShortcuts,
		pendingShortcut,
		takeSharedSong,
		takePlaylistShortcut,
		takePlayerNotification
	} from './lib/catalog/launcherShortcuts';
	import type { Category } from './lib/catalog/libraryBrowse';
	import { watchAccountTheme } from './lib/appearance/accountTheme';
	import { artworkColorScope, showArtworkPalette } from './lib/appearance/theme';
	import { watchArtworkPalette, type ArtworkPalette } from './lib/player/artworkPalette';
	import Appearance from './lib/appearance/Appearance.svelte';
	import brand from './assets/otohari-symbol.svg';
	let session = $state<Session | null>(null);
	let loading = $state(true);
	let tab = $state<BrowseDestination>('home');
	let initialCategory = $state<Category>();
	let panel = $state<'catalog' | 'player' | 'queue' | 'settings'>('catalog');
	setDetailSettings(() => openPanel('settings'));
	let catalogScroll = 0;
	let offlineLibrary = $state<OfflineLibrary>();
	let queueScope: SavedScope | undefined;
	let related = $state.raw<PlayerCredit>();
	let relatedScroll = 0,
		creditControl: HTMLElement | undefined;
	let fromPlayer = $state(false);
	let playerScroll = 0;
	type MiniAction = 'player' | 'queue';
	let miniReturn: MiniAction | undefined;
	let queueFromMini = false;
	let settingsOrigin: 'catalog' | 'player' | 'queue' = 'catalog';
	let settingsVisit = $state(0);
	let catalogVisit = $state(0);
	let initialSearch = $state('');
	async function openSharedSong() {
		const account = session;
		if (!account || !Capacitor.isNativePlatform() || document.hidden) return;
		const result = await takeSharedSong().catch(() => undefined);
		if (session !== account || !result?.text) return;
		const address = songLink(result.text);
		navigate('search', undefined, undefined, address);
		if (!address)
			issue = tr(
				'Share a song link from Spotify, Apple Music, Deezer, YouTube or song.link.',
				'Spotify、Apple Music、Deezer、YouTube、song.linkの曲リンクを共有してください。'
			);
	}
	const inPlayer = $derived(panel === 'player' || panel === 'queue');
	let issue = $state('');
	let main: HTMLElement;
	let shell = $state<HTMLElement>();
	let footerHeight = $state(0);
	let noticeHeight = $state(0);
	let artworkLyrics = $state(false);
	let editingQueue = $state(false);
	const pull = new PanelPull();
	const surface = $derived<PlayerSurface>(
		!related && (panel === 'player' || panel === 'queue') ? panel : 'base'
	);
	$effect(() => watchAccountTheme(session));
	const followArtwork = $derived($artworkColorScope !== 'off');
	let coverColors = $state.raw<ArtworkPalette>();
	$effect(() => {
		const account = session;
		coverColors = undefined;
		if (!followArtwork || !account) return;
		let previous: string | undefined;
		let stopCover: (() => void) | undefined;
		const stopPlayer = player.subscribe((state) => {
			const url = state.tracks[state.index]?.artworkUrl;
			if (url === previous) return;
			previous = url;
			stopCover?.();
			const path = url?.startsWith(account.serverUrl + '/')
				? url.slice(account.serverUrl.length)
				: url;
			stopCover = watchArtworkPalette(account, path, (colors) => (coverColors = colors));
		});
		return () => {
			stopPlayer();
			stopCover?.();
		};
	});
	$effect(() => {
		const visible =
			$artworkColorScope === 'app' || ($artworkColorScope === 'player' && surface !== 'base');
		showArtworkPalette(visible ? coverColors : undefined);
	});
	const peekingCatalog = $derived(surface !== 'base' && pull.includes('base'));
	const baseVisible = $derived(surface === 'base' || peekingCatalog);
	const layers = ['player', 'queue'] as const;
	let settings = $state<{ goBack: () => boolean }>();
	let catalog = $state<Catalog>();
	const catalogHeader = $derived(
		(panel === 'catalog' || peekingCatalog) && session ? catalog?.getHeader() : undefined
	);
	const dockDestination = $derived.by((): Destination => {
		if (panel === 'settings') return 'settings';
		const category = related
			? related.kind === 'album'
				? 'Albums'
				: 'Artists'
			: catalog?.getActiveCategory();
		const direct = libraryDestinations.find((item) => item.label === category);
		if (direct && $interfacePreferences.tabs.includes(direct.id)) return direct.id;
		return related || (tab === 'offline' && !$interfacePreferences.tabs.includes('offline'))
			? 'library'
			: tab;
	});
	function report(error: unknown) {
		issue = error instanceof Error ? error.message : 'The app could not finish that action.';
	}
	function switchPanel(update: () => void, to?: PlayerSurface) {
		const apply = () => {
			const animate = !pull.route;
			pull.clear();
			changeScreen(() => {
				update();
				if (!inPlayer) {
					artworkLyrics = false;
					editingQueue = false;
				}
			}, animate);
		};
		if (to && to !== surface && !pull.route && session) {
			beginPull(to, to === 'base' || surface === 'queue' ? 'down' : 'up');
			pull.settle(true, apply);
		} else apply();
	}
	function destination(direction: PullDirection): PlayerSurface | undefined {
		if (surface === 'base') return direction === 'up' ? 'player' : undefined;
		if (direction === 'down') return surface === 'queue' ? 'player' : 'base';
		const state = get(player);
		if (surface === 'player' && state.tracks[state.index]) return 'queue';
	}
	function panelHeight() {
		if (!shell) return 1;
		return Math.max(
			1,
			shell.clientHeight -
				(parseFloat(getComputedStyle(shell).paddingTop) || 0) -
				(issue ? noticeHeight : 0)
		);
	}
	function beginPull(to: PlayerSurface, direction: PullDirection) {
		const restoreScroll = !pull.route && to === 'base';
		cancelScreenMotion();
		const offset = pull.start(surface, to, direction, panelHeight());
		if (restoreScroll)
			void tick().then(() => {
				if (peekingCatalog) main.scrollTo(0, catalogScroll);
			});
		return offset;
	}
	const gestures: PlayerGestureActions = {
		up() {
			if (surface === 'player') toggleQueue();
			else if (related) returnToPlayer();
			else openPanel('player', true);
		},
		down() {
			if (surface === 'queue') {
				queueFromMini = false;
				toggleQueue();
			} else closePanel();
		},
		canStart(target, direction, origin) {
			if (!session || loading || document.querySelector('dialog[open]')) return false;
			if (pull.route) return pull.route.direction;
			if (!destination(direction)) return false;
			if (surface !== 'base')
				return target.closest('[data-panel-layer]')?.getAttribute('data-panel-layer') === surface;
			if (target.closest('[data-part="mini-player"]')) return true;
			if (panel !== 'catalog' || tab !== 'home') return false;
			const feed = main.querySelector<HTMLElement>('[data-home-feed]');
			if (!feed?.getClientRects().length) return false;
			if (target.closest('.mast') || (feed.contains(target) && target.closest('h1'))) return true;
			return (
				main.contains(target) &&
				(origin.pointerType === 'mouse' ||
					main.scrollHeight - main.clientHeight - main.scrollTop < 2)
			);
		},
		catchOnStart: () => !!pull.route,
		travel: () => pull.route?.height ?? panelHeight(),
		start(direction) {
			const to = pull.route?.to ?? destination(direction);
			return to ? beginPull(to, direction) : false;
		},
		move(_direction, pixels) {
			if (pull.route) pull.distance = pixels;
		},
		release(_direction, commit, navigate) {
			pull.settle(commit, navigate);
		}
	};
	function navigate(
		to: BrowseDestination,
		category?: Category,
		shortcutId?: string,
		sharedSearch = ''
	) {
		switchPanel(() => {
			clearRelated();
			catalogVisit++;
			initialCategory = category;
			initialSearch = sharedSearch;
			pendingShortcut.set(shortcutId && session ? { session, id: shortcutId } : null);
			tab = to;
			panel = 'catalog';
			issue = '';
			focusMain();
		});
	}
	function choose(to: Destination) {
		if (to === 'settings' && panel === 'settings') {
			fromPlayer = false;
			settingsVisit++;
			focusMain();
		} else if (to === 'settings') openPanel('settings');
		else if (
			to === 'playlists' ||
			to === 'artists' ||
			to === 'albums' ||
			to === 'tracks' ||
			to === 'genres'
		)
			navigate('library', libraryDestinations.find((d) => d.id === to)?.label);
		else navigate(to);
	}
	async function openPlayerNotification() {
		const owner = session;
		if (!owner || Capacitor.getPlatform() !== 'android') return;
		const pending = await takePlayerNotification().catch(() => undefined);
		if (pending?.open && session === owner && surface !== 'player') openPanel('player');
	}
	async function openDownloadNotification() {
		const owner = session;
		if (!owner?.userId || !offlineSupported || !Capacitor.isNativePlatform()) return;
		const pending = await nativeMedia
			.takeDownloadNotification(
				Capacitor.getPlatform() === 'ios'
					? { serverUrl: owner.serverUrl, userId: owner.userId }
					: undefined
			)
			.catch(() => undefined);
		if (pending?.open && session === owner) {
			navigate('offline');
		}
	}
	async function openPlaylistShortcut() {
		const account = session;
		if (!launcherShortcuts || !account?.userId) return;
		const request = await takePlaylistShortcut(account).catch(() => undefined);
		if (!request?.id || account !== session) return;
		navigate('library', 'Playlists', request.id);
	}
	function focusMain(offset = 0, miniAction?: MiniAction, settingsFocus = false) {
		void tick().then(() => {
			main?.scrollTo(0, offset);
			const footerButton =
				miniAction &&
				(shell?.querySelector<HTMLElement>(`footer [data-mini-action="${miniAction}"]`) ??
					shell?.querySelector<HTMLElement>('footer [data-mini-action="player"]'));
			(
				(settingsFocus &&
					Array.from(
						shell?.querySelectorAll<HTMLElement>(
							'[data-settings-shortcut], [data-destination="settings"]'
						) ?? []
					).find((el) => el.getClientRects().length)) ||
				footerButton ||
				main
			)?.focus({ preventScroll: true });
		});
	}
	function clearRelated() {
		related = undefined;
		creditControl = undefined;
	}
	function openCredit(kind: Credit, track: PlayerTrack, control: HTMLElement) {
		if (!inPlayer || !session || related) return;
		switchPanel(() => {
			relatedScroll = main?.scrollTop ?? 0;
			creditControl = control;
			related = { kind, track, scope: queueScope };
			focusMain();
		});
	}
	function returnToPlayer() {
		const control = creditControl,
			offset = relatedScroll;
		switchPanel(() => {
			panel = 'player';
			queueFromMini = false;
			clearRelated();
			void tick().then(() => {
				main?.scrollTo(0, offset);
				(control?.isConnected && !control.closest('[hidden]') ? control : main)?.focus({
					preventScroll: true
				});
			});
		}, 'player');
	}
	function openPanel(
		next: 'player' | 'queue' | 'settings',
		fromMini = false,
		returnOffset?: number
	) {
		switchPanel(
			() => {
				if (next !== 'settings') clearRelated();
				fromPlayer = false;
				if (panel === 'catalog') {
					catalogScroll = returnOffset ?? main?.scrollTop ?? 0;
					miniReturn = fromMini && next !== 'settings' ? next : undefined;
					queueFromMini = miniReturn === 'queue';
				}
				if (next === 'player') queueFromMini = false;
				if (next === 'settings') {
					settingsOrigin = panel === 'player' || panel === 'queue' ? panel : 'catalog';
					if (settingsOrigin !== 'catalog') playerScroll = main?.scrollTop ?? 0;
				}
				panel = next;
				focusMain();
			},
			next === 'settings' ? undefined : next
		);
	}
	function playerSettings() {
		switchPanel(() => {
			playerScroll = main?.scrollTop ?? 0;
			fromPlayer = true;
			settingsOrigin = panel === 'queue' ? 'queue' : 'player';
			panel = 'settings';
			focusMain();
		});
	}
	function finishPlayerLayout() {
		switchPanel(() => {
			queueFromMini = false;
			panel = 'player';
			focusMain(fromPlayer ? playerScroll : 0);
			fromPlayer = false;
		});
	}
	function closePanel() {
		const to = inPlayer && !related ? 'base' : undefined;
		switchPanel(() => {
			const closingSettings = panel === 'settings';
			const target = closingSettings ? settingsOrigin : 'catalog';
			if (target === 'catalog') clearRelated();
			settingsOrigin = 'catalog';
			panel = target;
			focusMain(
				target === 'catalog' ? catalogScroll : playerScroll,
				target === 'catalog' ? miniReturn : undefined,
				closingSettings && target === 'catalog'
			);
			if (target === 'catalog') {
				miniReturn = undefined;
				queueFromMini = false;
			}
		}, to);
	}
	function toggleQueue() {
		if (panel === 'queue' && queueFromMini) {
			closePanel();
			return;
		}
		switchPanel(
			() => {
				panel = panel === 'queue' ? 'player' : 'queue';
				focusMain();
			},
			panel === 'queue' ? 'player' : 'queue'
		);
	}
	function back() {
		if (pull.route && !pull.finishCommitted()) {
			pull.clear();
			return true;
		}
		if (!window.dispatchEvent(new CustomEvent('dn-back', { cancelable: true }))) return true;
		if (related && inPlayer) {
			returnToPlayer();
			return true;
		}
		if (panel === 'settings' && settings?.goBack()) return true;
		if (panel === 'queue') {
			toggleQueue();
			return true;
		}
		if (panel !== 'catalog') {
			closePanel();
			return true;
		}
		if (tab === 'offline') {
			navigate('library');
			return true;
		}
		if (catalog?.backToBoard()) return true;
		if (tab !== 'home') {
			navigate('home');
			return true;
		}
		return false;
	}
	$effect(() => {
		const owner = session;
		if (!owner || !offlineSupported) return;
		const controller = new AbortController();
		const stopFeedback = connectTrackFeedback(owner);
		const sync = () => {
			if (!document.hidden && navigator.onLine)
				void runAutoDownloads(owner, controller.signal).catch(() => {});
		};
		sync();
		window.addEventListener('online', sync);
		document.addEventListener('visibilitychange', sync);
		return () => {
			controller.abort();
			stopFeedback();
			void stopAutoDownloads(owner).catch(() => {});
			window.removeEventListener('online', sync);
			document.removeEventListener('visibilitychange', sync);
		};
	});
	$effect(() => {
		const owner = session;
		if (owner) return untrack(() => connectMobileDevice(owner));
	});
	let widget: ReturnType<typeof widgetLinks> | undefined;
	async function connected(next: Session) {
		let restoreError: unknown;
		let hasCurrentTrack = false;
		try {
			await player.restore(next);
			const queue = get(player);
			hasCurrentTrack = !!queue.tracks[queue.index];
			queueScope = await restoredQueueSource(next, queue.tracks);
		} catch (error) {
			restoreError = error;
		}
		const start = readStartScreen(next);
		if (start === 'automatic') {
			const offline =
				offlineSupported &&
				(!navigator.onLine || (await preferredOffline(next).catch(() => false)));
			tab = offline ? 'offline' : 'home';
		} else tab = start === 'player' ? 'library' : start;
		initialSearch = '';
		session = next;
		miniReturn = undefined;
		queueFromMini = false;
		panel = start === 'player' && hasCurrentTrack ? 'player' : 'catalog';
		catalogVisit++;
		focusMain();
		await openDownloadNotification();
		await openPlaylistShortcut();
		await openPlayerNotification();
		await openSharedSong();
		await widget?.consume();
		if (restoreError) report(restoreError);
	}
	async function start(tracks: PlayerTrack[], index: number, continuation?: LibraryContinuation) {
		const account = session;
		if (!account) return;
		const originVisit = catalogVisit,
			offset = panel === 'catalog' ? main?.scrollTop : undefined;
		const origin = related
			? related.scope
			: panel === 'catalog'
				? tab === 'offline'
					? offlineLibrary?.getPlaybackAvailability()
					: catalog?.getPlaybackAvailability()
				: undefined;
		try {
			await player.setQueue(tracks, index, account, continuation);
			if (session === account) {
				queueScope = origin;
				rememberQueueSource(account, origin, tracks);
				issue = '';
				openPanel('player', false, originVisit === catalogVisit ? offset : undefined);
			}
		} catch (error) {
			report(error);
		}
	}
	async function disconnect(expired = false) {
		const previous = session;
		if (!previous) return;
		pull.clear();
		artworkLyrics = false;
		editingQueue = false;
		session = null;
		clearRelated();
		rememberQueueSource(previous);
		queueScope = undefined;
		initialCategory = undefined;
		panel = 'catalog';
		tab = 'home';
		issue = '';
		const outcomes = await Promise.allSettled([
			stopIPhoneDownloads(previous),
			clearIPhonePlaylistShortcuts(previous),
			...(Capacitor.getPlatform() === 'android' && previous.userId
				? [nativeMedia.cancelManual({ serverUrl: previous.serverUrl, userId: previous.userId })]
				: []),
			player.clear(),
			expired ? forgetSession(previous) : signOut(previous)
		]);
		const failure = outcomes.find((item) => item.status === 'rejected');
		if (failure?.status === 'rejected') report(failure.reason);
		else if (expired) issue = 'Your session ended. Sign in again.';
	}
	onMount(() => {
		widget = widgetLinks(
			() => session,
			() => openPanel('player', true)
		);
		void restoreSession()
			.then(async (result) => {
				if (result) await connected(result);
				else if (Capacitor.isNativePlatform()) await player.clear();
			})
			.catch(report)
			.finally(() => (loading = false));
		const retryLogout = () => {
			if (!document.hidden) void retrySignOuts().catch(report);
		};
		retryLogout();
		window.addEventListener('online', retryLogout);
		document.addEventListener('visibilitychange', retryLogout);
		function expired(event: Event) {
			const old = (event as CustomEvent<Session>).detail;
			if (session && session.serverUrl === old.serverUrl && session.token === old.token)
				void disconnect(true);
		}
		function key(event: KeyboardEvent) {
			if (event.key === 'Escape' && back()) event.preventDefault();
		}
		const listener =
			Capacitor.getPlatform() === 'android'
				? NativeApp.addListener('backButton', () => {
						if (!back()) void NativeApp.minimizeApp().catch(report);
					})
				: null;
		const openOffline = () => {
			if (session && offlineSupported) navigate('offline');
		};
		const resetPull = () => pull.clear();
		window.addEventListener('resize', resetPull);
		window.addEventListener('dn-open-offline', openOffline);
		window.addEventListener('dn-download-notification', openDownloadNotification);
		window.addEventListener('dn-player-notification', openPlayerNotification);
		window.addEventListener('dn-playlist-shortcut', openPlaylistShortcut);
		window.addEventListener('dn-shared-song', openSharedSong);
		document.addEventListener('visibilitychange', openSharedSong);
		window.addEventListener('dn-session-expired', expired);
		window.addEventListener('keydown', key);
		return () => {
			pull.clear();
			window.removeEventListener('resize', resetPull);
			void listener?.then((handle) => handle.remove());
			window.removeEventListener('dn-open-offline', openOffline);
			window.removeEventListener('dn-download-notification', openDownloadNotification);
			window.removeEventListener('dn-player-notification', openPlayerNotification);
			widget?.stop();
			window.removeEventListener('dn-playlist-shortcut', openPlaylistShortcut);
			window.removeEventListener('dn-shared-song', openSharedSong);
			document.removeEventListener('visibilitychange', openSharedSong);
			window.removeEventListener('dn-session-expired', expired);
			window.removeEventListener('online', retryLogout);
			document.removeEventListener('visibilitychange', retryLogout);
			window.removeEventListener('keydown', key);
		};
	});
</script>

<div
	class="shell"
	data-part="app"
	bind:this={shell}
	use:playerGestures={gestures}
	class:pulling={!!pull.route}
	style:--footer-height={footerHeight + 'px'}
	style:--notice-height={(issue ? noticeHeight : 0) + 'px'}
>
	{#if baseVisible}
		<header
			class="mast"
			class:home-mast={tab === 'home' && (panel === 'catalog' || peekingCatalog)}
			inert={peekingCatalog}
			aria-hidden={peekingCatalog || undefined}
		>
			{#if catalogHeader}{@render catalogHeader()}{:else}
				<span
					class="brand-mark"
					role="img"
					aria-label="OtoHari"
					style:--brand-mark={'url("' + brand + '")'}
				></span>
			{/if}
			{#if panel !== 'settings' && (!session || !$interfacePreferences.tabs.includes('settings'))}
				<button
					type="button"
					class="icon-button settings-shortcut"
					data-settings-shortcut
					aria-label={uiText('Settings')}
					data-screen-link
					onclick={() => openPanel('settings')}><Menu size={24} /></button
				>
			{/if}
		</header>
	{/if}
	{#if issue}<div class="notice" bind:clientHeight={noticeHeight}>
			<p role="alert">{issue}</p>
			<button class="text-button" onclick={() => (issue = '')}>{uiText('Dismiss')}</button>
		</div>{/if}
	<main bind:this={main} tabindex="-1">
		{#if loading}<p role="status" class="pad">{uiText('Opening OtoHari…')}</p>
		{:else}
			{#if session}
				<div
					hidden={panel !== 'catalog' && !peekingCatalog}
					inert={peekingCatalog}
					aria-hidden={peekingCatalog || undefined}
					class="pad base-page"
				>
					{#key catalogVisit}{#if tab === 'offline'}<OfflineLibrary
								bind:this={offlineLibrary}
								{session}
								onplay={start}
							/>{:else}<Catalog
								bind:this={catalog}
								{session}
								active={panel === 'catalog'}
								{tab}
								{initialCategory}
								{initialSearch}
								onplay={start}
								onoffline={offlineSupported ? () => navigate('offline') : undefined}
								onnavigate={navigate}
							/>{/if}{/key}
				</div>
			{:else if panel !== 'settings'}
				<div class="pad"><Connect onconnected={connected} /></div>
			{/if}
			{#if panel === 'settings'}
				<div class="pad base-page">
					{#key settingsVisit}<Appearance
							bind:this={settings}
							onnavigate={choose}
							initial={fromPlayer ? 'player' : 'menu'}
							{session}
							onback={closePanel}
							onplayerlayoutclose={finishPlayerLayout}
							onsignout={() => disconnect()}
						/>{/key}
				</div>
			{/if}
			{#if session}
				<div class="panel-viewport">
					{#each layers as layer (layer)}
						{#if panel === layer || pull.includes(layer)}
							<div
								class="panel-layer"
								data-panel-layer={layer}
								hidden={!!related && !pull.includes(layer)}
								inert={surface !== layer}
								aria-hidden={surface !== layer || undefined}
								style:transform={pull.route
									? 'translate3d(0,' + pull.top(layer) + 'px,0)'
									: undefined}
							>
								<PlayerView
									oncredit={openCredit}
									{session}
									expanded
									bind:artworkLyrics
									bind:editing={editingQueue}
									transient={surface !== layer}
									queueOpen={layer === 'queue'}
									ontogglequeue={toggleQueue}
									onsettings={playerSettings}
									onexpand={() => {}}
									oncollapse={closePanel}
									onerror={report}
								/>
							</div>
						{/if}
					{/each}
				</div>
				{#if inPlayer && related}<div class="pad base-page">
						<PlayerLibraryDetail
							{session}
							credit={related}
							onback={returnToPlayer}
							onplay={start}
							onnavigate={navigate}
						/>
					</div>{/if}
			{/if}
		{/if}
	</main>
	{#if session && (panel === 'catalog' || peekingCatalog || (inPlayer && related) || (panel === 'settings' && !fromPlayer && $interfacePreferences.tabs.includes('settings')))}
		<footer
			bind:clientHeight={footerHeight}
			inert={peekingCatalog}
			aria-hidden={peekingCatalog || undefined}
		>
			<PlayerView
				{session}
				expanded={false}
				onexpand={() => (related && inPlayer ? returnToPlayer() : openPanel('player', true))}
				ontogglequeue={() => openPanel('queue', true)}
				oncollapse={() => {}}
				onerror={report}
			/>
			<Navigation current={dockDestination} offline={offlineSupported} onnavigate={choose} />
		</footer>
	{/if}
	{#if pull.route}<div class="pull-guard" aria-hidden="true"></div>{/if}
</div>

<style>
	.shell {
		position: relative;
		isolation: isolate;
		overflow: clip;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		max-width: 52rem;
		margin: auto;
		padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
	}
	.panel-viewport {
		display: contents;
	}
	.panel-layer {
		height: 100%;
		background: var(--bg);
		transition-property: none;
	}
	.pulling .panel-viewport {
		display: block;
		position: absolute;
		inset: calc(env(safe-area-inset-top) + var(--notice-height)) env(safe-area-inset-right) 0
			env(safe-area-inset-left);
		z-index: 2;
		overflow: clip;
		clip-path: inset(0 0 env(safe-area-inset-bottom));
	}
	.pulling .panel-layer {
		position: absolute;
		inset: 0;
		height: auto;
		overflow: clip;
		will-change: transform;
	}
	.pulling .panel-layer[data-panel-layer='queue'] {
		z-index: 3;
	}
	footer :global(.mini),
	.panel-layer :global(.player-section:not(:has([data-gesture-scroll], input, [role='slider']))) {
		touch-action: pinch-zoom;
	}
	/* A second touch can catch a moving screen without tapping a control underneath it. */
	.pull-guard {
		position: absolute;
		inset: 0;
		z-index: 4;
		touch-action: none;
	}
	.mast {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-height: 3.75rem;
		margin: 0 var(--gap);
	}
	.shell:has(:global([data-part='layout-preview'])) > .mast {
		display: none;
	}
	/* Album art provides its own back and settings controls. Keep the same frame
	   while the catalog is exposed beneath a moving player. */
	.shell:has(
			> main > .base-page:not([hidden]) :global(:is([data-part='album-page'], [data-detail-header]))
		)
		> .mast {
		display: none;
	}
	.pad.base-page:has(:global([data-part='album-page'])) {
		padding-inline: 0;
		padding-top: 0;
	}
	.mast.home-mast {
		min-height: 44px;
	}
	.pad.base-page:has(:global([data-home-feed]:not([hidden]))) {
		padding-top: 0;
	}
	.brand-mark {
		width: 3.35rem;
		aspect-ratio: 930 / 585;
		background: var(--brand-ink, #c8fb6c);
		mask: var(--brand-mark) left center / contain no-repeat;
		-webkit-mask: var(--brand-mark) left center / contain no-repeat;
	}
	@media (forced-colors: active) {
		.brand-mark {
			background: CanvasText;
			forced-color-adjust: none;
		}
	}
	.settings-shortcut {
		margin-inline-start: auto;
		flex: none;
	}
	main {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
	}
	main:focus {
		outline: none;
	}
	.pad {
		padding: var(--gap) var(--gap) max(2rem, env(safe-area-inset-bottom));
	}
	.notice {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--gap);
		padding: 0 var(--gap);
		background: var(--surface);
	}
	footer {
		padding-bottom: env(safe-area-inset-bottom);
		background: var(--bg);
	}
	:global(html[data-navigation='floating']) .shell:has(footer) .pad {
		padding-bottom: calc(var(--footer-height) + var(--gap));
	}
	:global(html[data-navigation='floating']) footer {
		position: absolute;
		inset: auto env(safe-area-inset-right) 0 env(safe-area-inset-left);
		background: transparent;
		pointer-events: none;
	}
	:global(html[data-navigation='floating']) footer :global(.mini),
	:global(html[data-navigation='floating']) footer :global(nav),
	:global(html[data-navigation='floating']) footer :global(dialog) {
		pointer-events: auto;
	}
</style>
