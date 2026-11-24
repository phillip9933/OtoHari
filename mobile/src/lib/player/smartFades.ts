import { audioLevels } from './audioAnalysis';
import type { PlayerTrack } from '../player';

export const maxOverlap = 8;
const binSeconds = 0.1;
const quietLevel = 0.063;

export function albumSequence(a: PlayerTrack, b: PlayerTrack) {
	const artist = a.albumArtist || a.artist;
	const sameAlbum =
		a.albumId && b.albumId
			? a.albumId === b.albumId
			: a.album &&
				a.album.toLowerCase() === b.album.toLowerCase() &&
				artist &&
				artist.toLowerCase() === (b.albumArtist || b.artist).toLowerCase();
	const disc = a.discNumber || 1,
		nextDisc = b.discNumber || 1;
	return (
		!!sameAlbum &&
		!!a.trackNumber &&
		!!b.trackNumber &&
		((disc === nextDisc && b.trackNumber === a.trackNumber + 1) ||
			(nextDisc === disc + 1 && b.trackNumber === 1))
	);
}

type Edge = { duration: number; levels: number[] };
const heads = new WeakMap<Blob, Edge>(),
	tails = new WeakMap<Blob, Edge>();
async function edge(
	blob: Blob,
	side: 'head' | 'tail',
	duration: number | undefined,
	signal: AbortSignal
) {
	const cache = side === 'tail' ? tails : heads;
	const hit = cache.get(blob);
	if (hit) return hit;
	const value = await audioLevels(blob, side, duration, signal);
	if (value && !signal.aborted) cache.set(blob, value);
	return value;
}
function quietSeconds(levels: number[]) {
	const loud = levels.findIndex((v) => v > quietLevel);
	const bins = loud < 0 ? levels.length : loud;
	return bins >= 2 ? bins * binSeconds : 0;
}

function regularPulses(chronological: number[]) {
	const hits: number[] = [];
	for (let i = 1; i < chronological.length; i++) {
		const level = chronological[i],
			previous = chronological[i - 1];
		if (
			level >= 0.09 &&
			level - previous >= 0.035 &&
			level >= 1.45 * previous &&
			(!hits.length || i - hits[hits.length - 1] >= 3)
		)
			hits.push(i);
	}
	if (hits.length < 5) return null;
	const period = (hits[hits.length - 1] - hits[0]) / (hits.length - 1);
	if (
		period < 3 ||
		period > 10 ||
		hits.some((v, i) => i > 0 && Math.abs(v - hits[i - 1] - period) > 1)
	)
		return null;
	return { hits, period };
}

// Anchor the first incoming attack on one of the last outgoing attacks at the original tempo.
function rhythmicOverlap(tail: number[], head: number[], cap: number) {
	const a = regularPulses([...tail].reverse()),
		b = regularPulses(head);
	if (!a || !b || Math.abs(a.period - b.period) > 0.1 * Math.min(a.period, b.period)) return 0;
	for (let count = 4; count >= 2; count--) {
		const seconds = (tail.length - a.hits[a.hits.length - count] + b.hits[0]) * binSeconds;
		if (seconds >= 0.4 && seconds <= cap) return seconds;
	}
	return 0;
}

// null means analysis was unavailable. A measured zero keeps an already clean boundary at unity.
export async function smartOverlap(
	outgoing: Blob,
	current: PlayerTrack,
	incoming: Blob,
	next: PlayerTrack,
	signal: AbortSignal
) {
	if (albumSequence(current, next)) return 0;
	const tail = await edge(outgoing, 'tail', current.duration, signal);
	if (!tail || signal.aborted) return null;
	const head = await edge(incoming, 'head', next.duration, signal);
	if (!head || signal.aborted) return null;
	const cap = Math.min(maxOverlap, tail.duration / 2, head.duration / 2);
	const quiet = Math.min(cap, quietSeconds(tail.levels) + quietSeconds(head.levels));
	return quiet >= 0.4 ? quiet : rhythmicOverlap(tail.levels, head.levels, cap);
}
