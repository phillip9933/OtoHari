import {
	browserConnection,
	browserFade,
	browserNetwork,
	streamProfiles,
	streamAddress
} from './streaming';
import {
	nextLibraryBatch,
	retainedHistory,
	refillAt,
	type LibraryContinuation
} from './libraryWindow';
import { queueSizeCheck } from '../catalog/libraryQueue';
import type { PlaybackBridge, PlaybackDelivery, PlayerState, PlayerTrack } from '../player';
import { cacheWebPlayback, isAudio, webLocalAudio, webPlaybackPolicy } from '../offline/web';
import { identifyAudio, setBrowserWaveformSource } from './waveform';

import { browserSpeed } from './sound';
import { similarTracks, type HeardTrack } from './autoplay';
import { albumSequence, maxOverlap, smartOverlap } from './smartFades';
import { shuffleInPlace, shuffleLocally } from './shuffle';

async function playbackBlob(response: Response, onprogress?: (fraction: number) => void) {
	const length = Number(response.headers.get('Content-Length'));
	const encoding = response.headers.get('Content-Encoding');
	if (
		!onprogress ||
		!response.body ||
		response.status !== 200 ||
		!Number.isSafeInteger(length) ||
		length <= 0 ||
		(encoding && encoding !== 'identity')
	)
		return response.blob();
	let received = 0;
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength;
				// Transfer percentage is useful before the authenticated Blob can be played.
				// Leave completion to the resolved Blob, even when the final chunk has arrived.
				if (received < length) onprogress(received / length);
				controller.enqueue(chunk);
			}
		})
	);
	return new Response(body, { headers: response.headers }).blob();
}

export function browserPlayer(onbuffer?: (state: PlayerState) => void): PlaybackBridge {
	let audio = new Audio();
	function speed(element: HTMLAudioElement) {
		element.defaultPlaybackRate = element.playbackRate = browserSpeed();
	}
	speed(audio);
	let state: PlayerState = {
		repeat: 'off',
		tracks: [],
		index: -1,
		playing: false,
		position: 0,
		duration: 0,
		error: null
	};
	let token = '';
	let serverUrl = '';
	let userId: string | undefined;
	let active: AbortController | undefined;
	let objectUrl: string | undefined;

	let windowCursor: LibraryContinuation | undefined;
	let windowExtras = new Set<PlayerTrack>();
	let loadingWindow: AbortController | undefined;
	let windowProblem: string | undefined,
		waitingAtEnd = false;
	let original: PlayerTrack[] | undefined;
	let upNext = new Set<PlayerTrack>();
	function pendingIndices() {
		if (!upNext.size) return [];
		const indices: number[] = [];
		for (let i = 0; i < state.tracks.length; i++) {
			if (i <= state.index) upNext.delete(state.tracks[i]);
			else if (upNext.has(state.tracks[i])) indices.push(i);
		}
		return indices;
	}
	function priorityEnd() {
		return (pendingIndices().at(-1) ?? state.index) + 1;
	}
	let history: HeardTrack[] = [];
	let heldPosition: number | undefined;
	function rememberPruned(tracks: PlayerTrack[]) {
		history = [
			...history,
			...tracks.slice(-500).map(({ id, recordingMbid }) => ({ id, recordingMbid }))
		].slice(-500);
	}
	let previous: ReturnType<typeof archive> | undefined;
	let radio: AbortController | undefined;
	let autoplay = false;
	let autoplayProblem: string | undefined;
	function preferenceKey(server = serverUrl, user = userId) {
		return 'dn.mobile.autoplay.' + JSON.stringify([server, user]);
	}
	function archive() {
		return {
			tracks: [...state.tracks],
			index: state.index,
			position: heldPosition ?? (audio.currentTime || 0),
			playing: !audio.paused || waitingAtEnd || !!radio,
			repeat: state.repeat,
			original: original && [...original],
			upNext: new Set(upNext),
			cursor: windowCursor,
			extras: new Set(windowExtras),
			history: [...history]
		};
	}
	function cancelRadio() {
		radio?.abort();
		radio = undefined;
		autoplayProblem = undefined;
	}
	async function continueRadio() {
		if (
			!autoplay ||
			radio ||
			!state.tracks.length ||
			state.index !== state.tracks.length - 1 ||
			state.repeat !== 'off' ||
			windowCursor?.after
		)
			return;
		const request = new AbortController();
		radio = request;
		autoplayProblem = undefined;
		try {
			const policy = userId
				? await webPlaybackPolicy({ serverUrl, userId }, state.tracks[state.index].id)
				: null;
			if (policy?.options.offlineOnly || !navigator.onLine)
				throw Error('Go online to continue with similar music.');
			const incoming = await similarTracks(
				{ serverUrl, userId, token, displayName: '' },
				state.tracks,
				request.signal,
				history
			);
			if (radio !== request) return;
			// A full 2,000-track queue can still continue. Retain as much played history as the bridge accepts.
			const fits = queueSizeCheck(serverUrl);
			incoming.forEach(fits);
			let trim = state.tracks.length;
			while (trim > 0) {
				try {
					fits(state.tracks[trim - 1]);
				} catch {
					break;
				}
				trim--;
			}
			if (trim === state.tracks.length)
				throw Error('The next tracks exceed the mobile queue size limit.');
			rememberPruned(state.tracks.slice(0, trim));
			const retained = state.tracks.slice(trim);
			if (original && trim) {
				const keep = new Set(retained);
				original = original.filter((t) => keep.has(t));
			}
			const next = [...retained, ...incoming];
			const index = retained.length;
			detachWindow();
			state.tracks = next;
			original?.push(...incoming);
			radio = undefined;
			await playAt(index);
		} catch (e) {
			if (!request.signal.aborted)
				autoplayProblem = e instanceof Error ? e.message : 'Could not load similar music.';
		} finally {
			if (radio === request) radio = undefined;
		}
	}
	let retryAlarm: ReturnType<typeof setTimeout> | undefined;
	function detachWindow() {
		loadingWindow?.abort();
		loadingWindow = undefined;
		windowCursor = undefined;
		windowExtras.clear();
		windowProblem = undefined;
		waitingAtEnd = false;
		clearTimeout(retryAlarm);
	}
	async function extendWindow(retry = false) {
		const cursor = windowCursor;
		if (!cursor || loadingWindow || (windowProblem && !retry)) return;
		if (
			cursor.after
				? state.tracks.length - state.index - 1 > refillAt
				: !waitingAtEnd || state.repeat !== 'all'
		)
			return;
		const request = new AbortController();
		loadingWindow = request;
		clearTimeout(retryAlarm);
		windowProblem = undefined;
		try {
			const policy = userId
				? await webPlaybackPolicy({ serverUrl, userId }, state.tracks[state.index]?.id ?? '').catch(
						() => null
					)
				: null;
			if (policy?.options.offlineOnly)
				throw Error('Turn off offline-only mode to load more library tracks.');
			const batch = await nextLibraryBatch(
				{ serverUrl, userId, token, displayName: '' },
				cursor,
				state.tracks.filter((entry) => !windowExtras.has(entry)),
				request.signal
			);
			if (request.signal.aborted || windowCursor !== cursor) return;
			const restart = cursor.after === null;
			if (
				restart
					? !waitingAtEnd || state.repeat !== 'all'
					: state.tracks.length - state.index - 1 > refillAt
			)
				return;
			const trim = restart ? state.tracks.length : Math.max(0, state.index - retainedHistory);
			const old = state.tracks.length - trim;
			if (trim > 0) rememberPruned(state.tracks.slice(0, trim));
			const retained = state.tracks.slice(trim);
			for (const entry of state.tracks.slice(0, trim)) windowExtras.delete(entry);
			const displayed = [...batch.tracks];
			if (original && !restart) shuffleInPlace(displayed);
			const tracks = [...retained, ...displayed];
			tracks.forEach(queueSizeCheck(serverUrl));
			if (restart) original = undefined;
			else if (original) {
				const keep = new Set(retained);
				original = [...original.filter((t) => keep.has(t)), ...batch.tracks];
			}
			state.tracks = tracks;
			state.index = restart ? 0 : state.index - trim;
			windowCursor = batch.continuation;
			const resume = waitingAtEnd;
			waitingAtEnd = false;
			if (resume) await playAt(old);
			else fadeVolume();
		} catch (e) {
			if (request.signal.aborted || cursor !== windowCursor) return;
			windowProblem = e instanceof Error ? e.message : 'Could not load more library tracks.';
			if (!retry)
				retryAlarm = setTimeout(() => {
					if (waitingAtEnd || !audio.paused) void extendWindow(true);
				}, 2200);
		} finally {
			if (loadingWindow === request) loadingWindow = undefined;
		}
	}
	window.addEventListener('online', () => {
		if (windowProblem && (waitingAtEnd || !audio.paused)) void extendWindow(true);
	});

	let sleepAlarm: ReturnType<typeof setTimeout> | undefined;
	let sleepingTrack: PlayerTrack | undefined;
	let pauseRevision = 0,
		blockAdvance = false;
	function cancelSleep() {
		clearTimeout(sleepAlarm);
		sleepAlarm = undefined;
		sleepingTrack = undefined;
		state.sleepTimer = null;
	}
	function checkSleep() {
		if (state.sleepTimer?.mode === 'minutes' && Date.now() >= state.sleepTimer.endsAt) {
			const finish = state.sleepTimer.finishTrack && (!audio.paused || audio.ended);
			cancelSleep();
			if (finish && state.tracks[state.index]) {
				sleepingTrack = state.tracks[state.index];
				state.sleepTimer = { mode: 'track', remaining: 1 };
				return;
			}
			pauseRevision++;
			cancelRadio();
			waitingAtEnd = false;
			blockAdvance = true;
			audio.pause();
		}
	}
	// A background tab may throttle timers. Media events and foregrounding also check the deadline.
	document.addEventListener('visibilitychange', checkSleep);
	window.addEventListener('pageshow', checkSleep);

	let fades = browserFade();
	let fadeTimer: ReturnType<typeof setTimeout> | undefined;
	let sourceBlob: Blob | undefined;
	let transferFraction = 0;
	let preserveIntro = false;
	type Prepared = {
		current: PlayerTrack;
		next: PlayerTrack;
		request: AbortController;
		media?: HTMLAudioElement;
		url?: string;
		source?: Awaited<ReturnType<typeof loadTrack>>;
		overlap?: number | null;
		mixStart?: number;
	};
	let prepared: Prepared | undefined;
	function release(element: HTMLAudioElement, url?: string) {
		element.pause();
		element.removeAttribute('src');
		element.load();
		if (url) URL.revokeObjectURL(url);
	}
	function discardNext() {
		if (!prepared) return;
		const old = prepared;
		prepared = undefined;
		old.request.abort();
		if (old.media) release(old.media, old.url);
	}
	function upcoming() {
		if (state.repeat === 'one' || state.sleepTimer || state.tracks.length < 2) return;
		return (
			state.tracks[state.index + 1] ??
			(state.repeat === 'all' && !windowCursor ? state.tracks[0] : undefined)
		);
	}
	async function prepareNext(pair: Prepared, outgoing: Blob) {
		const { request, current, next } = pair;
		try {
			const source = await loadTrack(next, request);
			if (request.signal.aborted) return;
			pair.source = source;
			pair.media = new Audio();
			speed(pair.media);
			pair.media.preload = 'auto';
			pair.media.volume = 0;
			pair.url = URL.createObjectURL(source.blob);
			pair.media.src = pair.url;
			pair.overlap = await smartOverlap(outgoing, current, source.blob, next, request.signal).catch(
				() => null
			);
		} catch {
			pair.overlap = null;
		}
		if (!request.signal.aborted) fadeVolume();
	}
	function fadeVolume() {
		clearTimeout(fadeTimer);
		const current = state.tracks[state.index];
		const next = fades.smart ? upcoming() : undefined;
		if (prepared && (current !== prepared.current || next !== prepared.next)) discardNext();
		const position = audio.currentTime || 0;
		const duration = Number.isFinite(audio.duration) ? audio.duration : (current?.duration ?? 0);
		const left = duration - position;
		if (
			!prepared &&
			current &&
			next &&
			sourceBlob &&
			duration > 0 &&
			left <= maxOverlap * 2 &&
			!audio.paused &&
			!audio.ended &&
			!blockAdvance
		) {
			prepared = { current, next, request: new AbortController() };
			void prepareNext(prepared, sourceBlob);
		}
		const pair = prepared;
		const controlled =
			!!next && (typeof pair?.overlap === 'number' || albumSequence(current, next));
		const fadeIn = preserveIntro && fades.smart ? 0 : fades.fadeInMs / 1000;
		const fadeOut = controlled ? 0 : fades.fadeOutMs / 1000;
		const scale = duration > 0 && fadeIn + fadeOut > duration ? duration / (fadeIn + fadeOut) : 1;
		let gain = Math.min(
			1,
			fadeIn ? position / (fadeIn * scale) : 1,
			fadeOut && duration > 0 ? Math.max(0, left) / (fadeOut * scale) : 1
		);
		if (
			pair?.overlap &&
			pair.media &&
			!audio.paused &&
			!audio.ended &&
			!audio.seeking &&
			!blockAdvance
		) {
			if (
				pair.mixStart === undefined &&
				left > 0 &&
				left <= pair.overlap &&
				pair.media.readyState >= 3
			) {
				pair.mixStart = position;
				pair.media.playbackRate = audio.playbackRate;
				void pair.media.play().catch(() => {
					if (pair === prepared) {
						pair.overlap = null;
						delete pair.mixStart;
						fadeVolume();
					}
				});
			}
			if (pair.mixStart !== undefined && !pair.media.paused) {
				const progress = Math.max(
					0,
					Math.min(1, (position - pair.mixStart) / Math.max(0.001, duration - pair.mixStart))
				);
				gain *= Math.cos(Math.PI * 0.5 * progress);
				pair.media.volume = Math.sin(Math.PI * 0.5 * progress);
			}
		}
		if (audio.volume !== gain) audio.volume = gain;
		if (audio.paused || audio.ended || !sourceBlob || duration <= 0) return;
		const endWindow = next ? maxOverlap * 2 : fadeOut * scale;
		if (position < fadeIn * scale || (endWindow && left <= endWindow)) {
			fadeTimer = setTimeout(fadeVolume, 50);
		} else if (endWindow) {
			fadeTimer = setTimeout(
				fadeVolume,
				Math.max(16, ((left - endWindow) * 1000) / audio.playbackRate)
			);
		}
	}
	function invalidateNext() {
		discardNext();
		fadeVolume();
	}
	window.addEventListener('dn-playback-speed', () => {
		speed(audio);
		if (prepared?.media) speed(prepared.media);
		fadeVolume();
	});
	const fadeEvents = ['play', 'playing', 'durationchange', 'ratechange', 'seeked'];
	function attach(element: HTMLAudioElement) {
		element.addEventListener('timeupdate', checkSleep);
		for (const e of fadeEvents) element.addEventListener(e, fadeVolume);
		element.addEventListener('seeking', invalidateNext);
		element.addEventListener('pause', stopped);
		element.onended = ended;
		element.onerror = mediaError;
	}
	function stopped() {
		if (audio.paused && !audio.ended) discardNext();
		fadeVolume();
	}
	function detach(element: HTMLAudioElement) {
		element.removeEventListener('timeupdate', checkSleep);
		for (const e of fadeEvents) element.removeEventListener(e, fadeVolume);
		element.removeEventListener('seeking', invalidateNext);
		element.removeEventListener('pause', stopped);
		element.onended = null;
		element.onerror = null;
	}
	window.addEventListener('dn-track-fade', () => {
		fades = browserFade();
		invalidateNext();
	});
	window.addEventListener('dn-offline-policy', () => {
		cancelRadio();
		invalidateNext();
	});
	window.addEventListener('offline', cancelRadio);
	window.addEventListener('dn-stream-profiles', invalidateNext);
	browserConnection()?.addEventListener('change', invalidateNext);
	window.addEventListener('offline', invalidateNext);
	window.addEventListener('online', invalidateNext);

	function unload() {
		discardNext();
		sourceBlob = undefined;
		transferFraction = 0;
		preserveIntro = false;
		clearTimeout(fadeTimer);
		setBrowserWaveformSource(null);
		state.quality = null;
		state.delivery = undefined;
		active?.abort();
		active = undefined;
		audio.pause();
		audio.removeAttribute('src');
		audio.load();
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		objectUrl = undefined;
	}

	function snapshot(): PlayerState {
		checkSleep();
		const duration = Number.isFinite(audio.duration)
			? audio.duration
			: (state.tracks[state.index]?.duration ?? 0);
		const bufferedEnd = duration * (sourceBlob?.size ? 1 : transferFraction);
		return {
			...state,
			shuffled: !!original,
			upNext: pendingIndices(),
			hasPreviousQueue: !!previous,
			autoplay,
			autoplayProblem,
			libraryWindow: windowCursor
				? {
						loaded: windowCursor.loaded,
						total: windowCursor.total,
						offset: windowCursor.loaded - state.tracks.length + windowExtras.size,
						extras: windowExtras.size
							? state.tracks.flatMap((entry, i) => (windowExtras.has(entry) ? [i] : []))
							: undefined,
						more: !!windowCursor.after,
						problem: windowProblem
					}
				: null,
			playing: waitingAtEnd || !!radio || !audio.paused,
			position: heldPosition ?? (audio.currentTime || 0),
			bufferedRanges: bufferedEnd > 0 ? [{ start: 0, end: bufferedEnd }] : [],
			duration
		};
	}

	async function loadTrack(
		track: PlayerTrack,
		request: AbortController,
		onprogress?: (fraction: number) => void
	) {
		// A web preview cannot attach a bearer header to an audio element.
		const account = userId ? { serverUrl, userId } : null;
		const accessToken = token;
		const profiles = streamProfiles({ serverUrl, userId });
		const network = browserNetwork();
		const group = network === 'wifi' ? 'wifi' : 'cellular';
		const profile = profiles[group];
		let cache: (() => void) | undefined;
		const local = account ? await webLocalAudio(account, track.id).catch(() => null) : null;
		let blob = local?.blob;
		const delivery: PlaybackDelivery = { source: local?.source ?? 'network' };
		if (!blob) {
			const policy = account ? await webPlaybackPolicy(account, track.id).catch(() => null) : null;
			const options = policy?.options;
			if (options?.offlineOnly) throw Error('This song is not stored on this device.');
			const source = new URL(streamAddress(track.streamUrl, profile));
			const load = (url: URL) =>
				fetch(url, {
					headers: { Authorization: 'Bearer ' + accessToken },
					credentials: 'omit',
					redirect: 'error',
					referrerPolicy: 'no-referrer',
					signal: request.signal
				});
			let response = await load(source);
			let fallback = false;
			if (
				response.status === 409 &&
				['opus', 'mp3'].includes(source.searchParams.get('format') ?? '')
			) {
				await response.body?.cancel();
				source.search = '?format=raw';
				response = await load(source);
				fallback = true;
			}
			if (!response.ok) throw new Error('DroppedNeedle could not serve this track.');
			delivery.network = network;
			delivery.profile = group;
			delivery.requestedFormat = profile.format;
			if (profile.format !== 'original') delivery.requestedRate = profile.rate;
			const ranges = response.headers.get('Accept-Ranges')?.toLowerCase();
			if (fallback) delivery.response = 'fallback';
			else if (profile.format === 'original' || ranges === 'bytes') delivery.response = 'original';
			else if (ranges === 'none') delivery.response = 'converted';
			blob = await playbackBlob(response, onprogress);
			if (
				account &&
				policy?.options.autoCache &&
				!source.searchParams.has('start_seconds') &&
				blob.size &&
				response.status === 200 &&
				isAudio(response.headers.get('content-type')) &&
				!request.signal.aborted
			)
				cache = () => {
					void cacheWebPlayback(account, track, blob!, policy.revision);
				};
		}
		return { blob, cache, delivery };
	}

	async function playAt(index: number, play = true, position = 0) {
		const track = state.tracks[index];
		if (!track) throw new Error('This track is outside the play queue.');
		if (sleepingTrack && sleepingTrack !== track) cancelSleep();
		if (state.sleepTimer?.mode === 'track') sleepingTrack = track;
		blockAdvance = false;
		const playRevision = pauseRevision;
		unload();
		state = { ...state, index, error: null };
		pendingIndices();
		waitingAtEnd = false;
		heldPosition = play ? undefined : position;
		if (!play) return;
		void extendWindow();
		const request = new AbortController();
		active = request;
		try {
			let lastUpdate = -Infinity;
			const source = await loadTrack(track, request, (fraction) => {
				if (request !== active || request.signal.aborted) return;
				transferFraction = fraction;
				const now = performance.now();
				if (onbuffer && !document.hidden && now - lastUpdate >= 250) {
					lastUpdate = now;
					onbuffer(snapshot());
				}
			});
			if (request.signal.aborted) return;
			source.cache?.();
			state.delivery = source.delivery;
			const blob = source.blob;
			sourceBlob = blob;
			setBrowserWaveformSource({ serverUrl, userId, id: track.id, blob });
			const quality = await identifyAudio(blob, track.duration).catch(() => null);
			if (request.signal.aborted) return;
			state.quality = quality;
			objectUrl = URL.createObjectURL(blob);
			audio.src = objectUrl;
			if (position > 0) audio.currentTime = position;
			fadeVolume();
			checkSleep();
			if (play && playRevision === pauseRevision) await audio.play();
		} catch (error) {
			if (request.signal.aborted) return;
			transferFraction = 0;
			state.error = 'This track could not be played.';
			onbuffer?.(snapshot());
			throw error;
		}
	}

	function ended() {
		if (blockAdvance) return;
		const playRevision = pauseRevision;
		checkSleep();
		if (pauseRevision !== playRevision) return;
		if (state.sleepTimer?.mode === 'track') {
			const left = (state.sleepTimer.remaining ?? 1) - 1;
			if (left < 1) {
				cancelSleep();
				blockAdvance = true;
				audio.pause();
				return;
			}
			state.sleepTimer = { mode: 'track', remaining: left };
			sleepingTrack = state.repeat === 'one' ? state.tracks[state.index] : undefined;
			if (
				state.repeat === 'off' &&
				!windowCursor?.after &&
				!autoplay &&
				state.index + 1 >= state.tracks.length
			)
				cancelSleep();
		}
		if (state.repeat === 'one') {
			preserveIntro = false;
			audio.currentTime = 0;
			void audio.play().catch(() => {
				state.error = 'This track could not be played.';
			});
		} else if (
			windowCursor &&
			state.index + 1 === state.tracks.length &&
			(windowCursor.after || state.repeat === 'all')
		) {
			waitingAtEnd = true;
			void extendWindow();
		} else if (state.index + 1 < state.tracks.length || state.repeat === 'all') {
			const index = (state.index + 1) % state.tracks.length;
			const next = state.tracks[index];
			const pair = prepared;
			const gapless =
				fades.smart && !state.sleepTimer && albumSequence(state.tracks[state.index], next);
			if (pair?.next === next && pair.media && !pair.media.error && pair.source) {
				prepared = undefined;
				pair.request.abort();
				detach(audio);
				release(audio, objectUrl);
				audio = pair.media;
				objectUrl = pair.url;
				sourceBlob = pair.source.blob;
				active?.abort();
				const request = new AbortController();
				active = request;
				state = { ...state, index, error: null, quality: null, delivery: pair.source.delivery };
				pendingIndices();
				preserveIntro = typeof pair.overlap === 'number' || gapless;
				setBrowserWaveformSource({ serverUrl, userId, id: next.id, blob: sourceBlob });
				pair.source.cache?.();
				void identifyAudio(sourceBlob, next.duration)
					.then((quality) => {
						if (!request.signal.aborted) state.quality = quality;
					})
					.catch(() => {});
				attach(audio);
				fadeVolume();
				if (audio.paused)
					void audio.play().catch(() => {
						if (!request.signal.aborted) state.error = 'This track could not be played.';
					});
				void extendWindow();
			} else {
				const result = playAt(index);
				preserveIntro = gapless;
				void result.catch(() => {});
			}
		} else if (autoplay) void continueRadio();
	}
	function mediaError() {
		if (audio.hasAttribute('src')) state.error = 'This audio format could not be played.';
	}
	attach(audio);
	return {
		async autoplaySetting(options) {
			const key = preferenceKey(options.serverUrl, options.userId);
			if (options.enabled !== undefined) {
				localStorage.setItem(key, String(options.enabled));
				if (options.serverUrl === serverUrl && options.userId === userId) {
					autoplay = options.enabled;
					if (!autoplay) cancelRadio();
				}
			}
			return { enabled: localStorage.getItem(key) === 'true' };
		},
		async getState() {
			return snapshot();
		},
		async setQueue(options) {
			if (options.placement && state.tracks.length) {
				if (token !== options.token || serverUrl !== options.serverUrl || userId !== options.userId)
					throw new Error('This queue belongs to a different session.');
				const entries = options.tracks.map((t) => ({ ...t }));
				cancelRadio();
				const at =
					options.placement === 'next'
						? state.index + 1
						: options.placement === 'upNext'
							? priorityEnd()
							: state.tracks.length;
				const resume = options.placement !== 'end' && waitingAtEnd && at === state.tracks.length;
				if (options.placement === 'end') detachWindow();
				else
					for (const entry of entries) {
						upNext.add(entry);
						if (windowCursor) windowExtras.add(entry);
					}
				if (original)
					original.splice(
						options.placement !== 'end'
							? original.indexOf(state.tracks[at - 1]) + 1
							: original.length,
						0,
						...entries
					);
				state.tracks = [...state.tracks.slice(0, at), ...entries, ...state.tracks.slice(at)];
				if (resume) await playAt(at);
				fadeVolume();
				return snapshot();
			}
			const same =
				serverUrl === options.serverUrl && userId === options.userId && token === options.token;
			previous = same && state.tracks.length ? archive() : undefined;
			original = undefined;
			upNext = new Set();
			cancelRadio();
			if (!same) cancelSleep();
			detachWindow();
			windowCursor = options.continuation;
			serverUrl = options.serverUrl;
			userId = options.userId;
			token = options.token;
			if (!same) autoplay = localStorage.getItem(preferenceKey()) === 'true';
			state.tracks = options.tracks.map((t) => ({ ...t }));
			if (options.placement === 'next' || options.placement === 'upNext')
				upNext = new Set(state.tracks.slice(options.index + 1));
			history = [];
			await playAt(options.index, options.playing ?? true, options.positionSeconds ?? 0);
			return snapshot();
		},
		async command({ action, value, to }) {
			const waitingForRadio = !!radio;
			if (action === 'setAutoplay') {
				autoplay = !!value;
				if (serverUrl) localStorage.setItem(preferenceKey(), String(autoplay));
				if (!autoplay) cancelRadio();
				return snapshot();
			}
			if (action === 'retryAutoplay') {
				await continueRadio();
				return snapshot();
			}
			if (action === 'setPlaying') {
				if (value && (waitingAtEnd || waitingForRadio || !audio.paused)) return snapshot();
				if (!value && !waitingAtEnd && !waitingForRadio && audio.paused && !active)
					return snapshot();
				if (!value) {
					pauseRevision++;
					blockAdvance = true;
					waitingAtEnd = false;
					cancelRadio();
					audio.pause();
					return snapshot();
				}
				action = 'toggle';
			}
			cancelRadio();
			if (action === 'restorePreviousQueue' && previous) {
				const old = previous;
				previous = archive();
				detachWindow();
				windowCursor = old.cursor;
				windowExtras = old.extras;
				history = old.history;
				original = old.original;
				upNext = old.upNext;
				state.tracks = old.tracks;
				state.repeat = old.repeat;
				await playAt(old.index, old.playing, old.position);
				return snapshot();
			}
			if (action !== 'retryLibraryWindow') discardNext();
			if (action === 'retryLibraryWindow') {
				await extendWindow(true);
				return snapshot();
			}
			const editsPicks =
				value !== undefined &&
				windowExtras.has(state.tracks[value]) &&
				(action === 'remove' ||
					(action === 'move' && to !== undefined && windowExtras.has(state.tracks[to])));
			if (!editsPicks && ['move', 'remove', 'clearUpcoming', 'clear'].includes(action))
				detachWindow();
			if (action === 'toggle' && (waitingAtEnd || waitingForRadio)) {
				waitingAtEnd = false;
				audio.pause();
				return snapshot();
			}
			if (
				action === 'next' &&
				windowCursor &&
				state.index + 1 === state.tracks.length &&
				(windowCursor.after || state.repeat === 'all')
			) {
				waitingAtEnd = true;
				await extendWindow(true);
				return snapshot();
			}
			if (action === 'cancelSleepTimer') {
				cancelSleep();
				fadeVolume();
				return snapshot();
			}
			if (action === 'setSleepMinutes' || action === 'sleepAfterTrack') {
				const current = state.tracks[state.index];
				if (!current) throw Error('Choose a track first.');
				if (
					action === 'setSleepMinutes' &&
					(!Number.isInteger(value) || value! < 1 || value! > 240)
				)
					throw Error('Choose a whole number from 1 to 240 minutes.');
				const count = value ?? 1;
				if (action === 'sleepAfterTrack' && (!Number.isInteger(count) || count < 1 || count > 99))
					throw Error('Choose between 1 and 99 tracks.');
				cancelSleep();
				if (action === 'sleepAfterTrack') {
					sleepingTrack = current;
					state.sleepTimer = { mode: 'track', remaining: count };
				} else {
					const ms = value! * 60_000;
					state.sleepTimer = { mode: 'minutes', endsAt: Date.now() + ms, finishTrack: to === 1 };
					sleepAlarm = setTimeout(checkSleep, ms);
				}
				fadeVolume();
				return snapshot();
			}
			if (action === 'clear' || (action === 'remove' && value === 0 && state.tracks.length === 1)) {
				cancelSleep();
				unload();
				token = serverUrl = '';
				userId = undefined;
				previous = original = undefined;
				upNext.clear();
				autoplay = false;
				history = [];
				heldPosition = undefined;
				state = { ...state, repeat: 'off', tracks: [], index: -1, error: null };
			} else if (state.tracks.length) {
				if (action === 'seek' && Number.isFinite(value)) {
					waitingAtEnd = false;
					if (heldPosition !== undefined) heldPosition = Math.max(0, value!);
					else audio.currentTime = Math.max(0, value!);
				}
				if (action === 'skipTo' && Number.isInteger(value)) await playAt(value!);
				else if (
					action === 'next' &&
					(state.index + 1 < state.tracks.length || state.repeat === 'all')
				)
					await playAt((state.index + 1) % state.tracks.length);
				else if (
					action === 'next' &&
					state.index === state.tracks.length - 1 &&
					state.repeat === 'off' &&
					!windowCursor?.after &&
					autoplay &&
					!waitingForRadio
				)
					await continueRadio();
				if (action === 'previous') {
					waitingAtEnd = false;
					if ((heldPosition ?? audio.currentTime) > 3 || state.index === 0) {
						if (heldPosition !== undefined) heldPosition = 0;
						else audio.currentTime = 0;
					} else await playAt(state.index - 1);
				}
				if (action === 'cycleRepeat') {
					state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
					if (windowCursor?.after === null && state.repeat !== 'all') waitingAtEnd = false;
				}
				if (action === 'clearUpcoming') {
					upNext.clear();
					state.tracks = state.tracks.slice(0, state.index + 1);
					if (original) {
						const retained = new Set(state.tracks);
						original = original.filter((t) => retained.has(t));
					}
				}
				if (action === 'shuffleUpcoming') {
					const start = state.index + 1;
					const priority = pendingIndices().map((index) => state.tracks[index]);
					if (original) {
						const current = state.tracks[state.index];
						const base = original.filter((entry) => !upNext.has(entry));
						state.index = base.indexOf(current);
						state.tracks = [
							...base.slice(0, state.index + 1),
							...priority,
							...base.slice(state.index + 1)
						];
						original = undefined;
					} else if (state.tracks.length - priority.length > start + 1) {
						original = [...state.tracks];
						state.tracks = [
							...original.slice(0, start),
							...priority,
							...shuffleLocally(
								original.slice(start).filter((entry) => !upNext.has(entry)),
								{ serverUrl, userId },
								'upcoming'
							)
						];
					}
				}
				if (action === 'prioritize') {
					if (
						value === undefined ||
						!Number.isInteger(value) ||
						value <= state.index ||
						!state.tracks[value]
					)
						throw Error('Choose an upcoming track.');
					const entry = state.tracks[value];
					const end = priorityEnd();
					state.tracks = [...state.tracks];
					state.tracks.splice(value, 1);
					const to = value < end ? end - 1 : end;
					if (original) {
						original.splice(original.indexOf(entry), 1);
						original.splice(original.indexOf(state.tracks[to - 1]) + 1, 0, entry);
					}
					state.tracks.splice(to, 0, entry);
					upNext.add(entry);
				}
				if (
					(action === 'move' || action === 'remove') &&
					value !== undefined &&
					Number.isInteger(value) &&
					state.tracks[value]
				) {
					const current = state.tracks[state.index];
					if (action === 'move' && to !== undefined && Number.isInteger(to) && state.tracks[to]) {
						if (to !== value) {
							if (to > state.index && upNext.has(state.tracks[to])) upNext.add(state.tracks[value]);
							else upNext.delete(state.tracks[value]);
						}
						const moved = [...state.tracks];
						moved.splice(to, 0, ...moved.splice(value, 1));
						state.tracks = moved;
						original = undefined;
						state.index = state.tracks.indexOf(current);
					}
					if (action === 'remove') {
						upNext.delete(state.tracks[value]);
						windowExtras.delete(state.tracks[value]);
						const play = !audio.paused;
						if (original) original.splice(original.indexOf(state.tracks[value]), 1);
						state.tracks = state.tracks.filter((_, index) => index !== value);
						if (value === state.index) await playAt(Math.min(value, state.tracks.length - 1), play);
						else state.index = state.tracks.indexOf(current);
					}
				}
				if (action === 'toggle') {
					blockAdvance = !audio.paused;
					if (audio.paused && (audio.ended || !objectUrl || state.error))
						await playAt(state.index, true, heldPosition ?? 0);
					else if (audio.paused) await audio.play();
					else audio.pause();
				}
			}
			fadeVolume();
			return snapshot();
		}
	};
}
