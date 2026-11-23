import type { components } from '../../../../frontend/src/lib/api/v3/openapi';
import { DnError, getJson, mutateJson, postJson, type Session } from '../connection';
import { path } from './catalog';
import type { DeckCard } from './discoveryWidgets';

type Schema = components['schemas'];
export type Answer = 'no' | 'know_it' | 'not_now' | 'not_artist';
export type Feedback = {
	target: 'album' | 'artist';
	target_mbid: string;
	kind: Answer;
	artist_name: string;
	release_name: string;
	expires_at?: number | null;
};
export type Tuning = { kind: string; target: string; name: string };
type Seed = { artist_mbid: string; name: string; turned_down: boolean };
export type Evidence = { reason: { line: string }; seeds: Seed[] };

// These endpoints were added after the v3 contract bundled with older DN servers.
const feedback = '/api/v3/discover/feedback';
const tunings = '/api/v3/discover/tunings';
function unavailable(error: unknown) {
	return error instanceof DnError && (error.status === 404 || error.status === 405);
}

export async function readFeedback(session: Session) {
	try {
		const { items } = await getJson<{ items: Feedback[] }>(session, feedback);
		return { legacy: false, items };
	} catch (error) {
		if (!unavailable(error)) throw error;
	}
	const { items } = await getJson<Schema['IgnoredReleasesResponse']>(
		session,
		path('/api/v3/discover/queue/ignored')
	);
	return {
		legacy: true,
		items: items.map((row): Feedback => ({
			kind: 'no',
			target: 'album',
			target_mbid: row.release_group_mbid,
			release_name: row.release_name,
			artist_name: row.artist_name
		}))
	};
}

export async function answerDiscover(
	session: Session,
	card: DeckCard,
	kind: Answer,
	legacy: boolean,
	queue: boolean
) {
	const release = {
		release_group_mbid: card.album.group ?? undefined,
		artist_mbid: card.artistId || undefined,
		artist_name: card.album.artist,
		release_name: card.album.title
	};
	if (legacy) {
		if (kind !== 'no' || !release.release_group_mbid || !release.artist_mbid)
			throw Error(
				'This DroppedNeedle version only supports hiding an album with an identified artist.'
			);
		await postJson(session, path('/api/v3/discover/queue/ignore'), {
			...release,
			release_group_mbid: release.release_group_mbid,
			artist_mbid: release.artist_mbid
		} satisfies Schema['QueueIgnoreRequest']);
		return {
			kind,
			target: 'album',
			target_mbid: release.release_group_mbid,
			...release
		} satisfies Feedback;
	}
	return postJson<Feedback>(session, feedback, {
		...release,
		kind,
		made_from: queue ? 'deck' : 'top_picks'
	});
}

export function undoFeedback(session: Session, row: Feedback, legacy: boolean) {
	const url = legacy
		? path('/api/v3/discover/queue/ignored/{release_group_mbid}', {
				release_group_mbid: row.target_mbid
			})
		: feedback + '/' + encodeURIComponent(row.target) + '/' + encodeURIComponent(row.target_mbid);
	return mutateJson(session, url, 'DELETE');
}

export async function readTunings(session: Session) {
	try {
		return (await getJson<{ items: Tuning[] }>(session, tunings)).items;
	} catch (error) {
		if (unavailable(error)) return [];
		throw error;
	}
}

export async function pickEvidence(session: Session, id: string) {
	try {
		return await getJson<Evidence>(
			session,
			'/api/v3/discover/picks/' + encodeURIComponent(id) + '/why'
		);
	} catch (error) {
		if (unavailable(error)) return undefined;
		throw error;
	}
}

export function reduceSeed(session: Session, id: string) {
	return postJson<Tuning>(session, tunings, { kind: 'less_from_seed', target: id });
}
export function undoTuning(session: Session, row: Tuning) {
	return mutateJson(
		session,
		tunings + '/' + encodeURIComponent(row.kind) + '/' + encodeURIComponent(row.target),
		'DELETE'
	);
}
