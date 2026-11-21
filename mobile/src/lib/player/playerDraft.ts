import { hasSavedPlayerLayout, type Section } from '../boards/layout';
import { defaultGridLayout, isPlayerGrid, editablePlayerGrid, emptyPlayerTile } from './grid';
import { legacyRowDefaults, previousPlayerDefaults } from './layout';
import { packPlayerCanvas, playerCanvas } from './composition';
import { exportPlayerStyle, importPlayerStyle } from './playerStyle';

let opening: Promise<IDBDatabase> | undefined;
function database() {
	if (!opening) {
		opening = new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('dn.mobile.player-drafts', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('layouts');
			request.onblocked = () => reject(new Error('Draft storage is busy.'));
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => {
					db.close();
					opening = undefined;
				};
				resolve(db);
			};
		}).catch((error) => {
			opening = undefined;
			throw error;
		});
	}
	return opening;
}

export type PlayerDraft = Awaited<ReturnType<typeof openPlayerDraft>>;

export async function openPlayerDraft(
	server: string,
	user: string,
	saved: Section[],
	useStarter = false
) {
	function asDraft(sections: Section[]) {
		const visible = editablePlayerGrid(sections);
		return visible.length ? visible : [emptyPlayerTile()];
	}
	const explicit = hasSavedPlayerLayout(server, user);
	const baseGrid = explicit && !useStarter ? asDraft(saved) : defaultGridLayout();
	let initial = baseGrid;
	let initialFingerprint = '';
	function snapshot(items: Section[]) {
		if (isPlayerGrid(items)) return exportPlayerStyle(items, 'compact');
		const hidden = items.filter((s) => s.placement === 'hidden');
		return exportPlayerStyle(packPlayerCanvas(playerCanvas(items), hidden), 'compact');
	}
	let baseline = '';
	let previous = '';
	let newest = 0;
	let db: IDBDatabase | undefined;
	const owned = new Set<IDBValidKey>();
	try {
		// Keep the baseline for an unsaved account stable across starter layout changes.
		baseline = snapshot(explicit ? saved : legacyRowDefaults());
		initialFingerprint = exportPlayerStyle(baseGrid, 'compact');
		previous = initialFingerprint;
		db = await database();
		const store = db.transaction('layouts', 'readwrite').objectStore('layouts');
		const range = IDBKeyRange.bound([server, user], [server, user, []]);
		const cursor = store.openCursor(range, 'prev');
		const formerBaselines = new Map<string, boolean>();
		const formerDefault = explicit
			? ''
			: exportPlayerStyle(packPlayerCanvas(playerCanvas(previousPlayerDefaults()), []), 'compact');
		await new Promise<void>((resolve, reject) => {
			cursor.onerror = () => reject(cursor.error);
			cursor.onsuccess = () => {
				const item = cursor.result;
				if (!item) return resolve();
				const record = item.value;
				// Compare legacy row and coarse grid snapshots in the same format as the saved layout.
				if (
					typeof record?.baseline === 'string' &&
					record.baseline !== baseline &&
					!formerBaselines.has(record.baseline)
				) {
					let same = false;
					try {
						const old = importPlayerStyle(record.baseline);
						const normalized = snapshot(old);
						same = normalized === baseline || normalized === formerDefault;
					} catch {
						/* An unreadable baseline cannot identify this draft. */
					}
					formerBaselines.set(record.baseline, same);
				}
				if (
					(record?.baseline === baseline || formerBaselines.get(record?.baseline)) &&
					typeof record.layout === 'string'
				) {
					try {
						initial = asDraft(importPlayerStyle(record.layout));
						previous = exportPlayerStyle(initial, 'compact');
						newest = Number((item.primaryKey as IDBValidKey[])[2]) || 0;
						owned.add(item.primaryKey);
						return resolve();
					} catch {
						// Discard an unreadable copy and look for the next valid draft.
					}
				}
				item.delete();
				item.continue();
			};
		});
	} catch {
		// The saved player remains editable when draft storage is unavailable.
	}

	function replace(layout?: string) {
		if (!layout && !owned.size) return Promise.resolve();
		if (!db) throw new Error('Draft storage is unavailable.');
		const tx = db.transaction('layouts', 'readwrite', { durability: 'strict' });
		const store = tx.objectStore('layouts');
		const superseded = [...owned];
		for (const key of superseded) store.delete(key);
		if (layout) {
			// Unique revisions let Cancel remove this editor's copy while preserving other windows.
			newest = Math.max(Date.now(), newest + 1);
			const key = [server, user, newest, crypto.randomUUID()];
			store.put({ baseline, layout }, key);
			owned.add(key);
		}
		// Submit the complete transaction before a navigation or the activity can interrupt it.
		tx.commit?.();
		return new Promise<void>((resolve, reject) => {
			tx.onabort = () => reject(tx.error);
			tx.oncomplete = () => {
				for (const key of superseded) owned.delete(key);
				resolve();
			};
		});
	}
	let currentWrite = Promise.resolve('');
	function remember(items: Section[]) {
		const issue = 'Your device could not keep a recovery copy. Save the layout before you leave.';
		try {
			const layout = exportPlayerStyle(items, 'compact');
			if (layout === previous) return currentWrite;
			if (!baseline) return Promise.resolve(issue);
			previous = layout;
			currentWrite = replace(layout === initialFingerprint ? undefined : layout).then(
				() => '',
				() => issue
			);
			return currentWrite;
		} catch {
			return Promise.resolve(issue);
		}
	}
	return {
		initial,
		recovered: initial !== baseGrid,
		remember,
		clear: async () => replace()
	};
}
