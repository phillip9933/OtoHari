import { DnError, postJson, type Session } from '../connection';

type Event = 'shown' | 'opened' | 'sampled';
type Reports = {
	supported?: boolean;
	probe?: Promise<void>;
	day: string;
	shown: Set<string>;
};
const reports = new WeakMap<Session, Reports>();

export function forgetPickObservations(session: Session) {
	reports.delete(session);
}

// These observations never hold up navigation or count as scrobbles. Probe the
// first actual observation once, since older servers have no observations route.
export async function reportPick(session: Session, group: string | null | undefined, event: Event) {
	if (!group) return;
	let state = reports.get(session);
	const day = new Date().toISOString().slice(0, 10);
	if (!state) {
		state = { day, shown: new Set() };
		reports.set(session, state);
	}
	if (state.day !== day) {
		state.day = day;
		state.shown.clear();
	}
	if (state.probe) await state.probe;
	if (reports.get(session) !== state) return;
	if (state.supported === false || (event === 'shown' && state.shown.has(group))) return;
	if (event === 'shown') state.shown.add(group);
	const send = postJson(session, '/api/v3/discover/picks/events', {
		release_group_mbid: group,
		event
	}).then(
		() => {
			state.supported = true;
		},
		(cause) => {
			if (cause instanceof DnError && (cause.status === 404 || cause.status === 405))
				state.supported = false;
			if (event === 'shown' && day === state.day) state.shown.delete(group);
		}
	);
	if (state.supported === undefined) state.probe = send;
	await send;
	if (state.probe === send) state.probe = undefined;
}

export function observePick(session: Session, group: string | null | undefined, active: boolean) {
	if (!group || !active) return;
	return (node: HTMLElement) => {
		let visible = false;
		const shown = () => {
			if (visible && !document.hidden) void reportPick(session, group, 'shown');
		};
		const observer = new IntersectionObserver(
			([entry]) => {
				visible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
				shown();
			},
			{ threshold: 0.5 }
		);
		observer.observe(node);
		document.addEventListener('visibilitychange', shown);
		return () => {
			observer.disconnect();
			document.removeEventListener('visibilitychange', shown);
		};
	};
}
