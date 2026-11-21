import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { PlayerTrack } from '../player';
import type { OfflineBridge } from './web';
import type { OfflinePin, DownloadSource } from './tracks';
import type { CollectionMember } from './resolveCollections';

type Account = { serverUrl: string; userId: string };
export type HistoryStatus = { enabled: boolean; pending: number };
export type DownloadNotificationState = 'appOff' | 'appOn' | 'channelOff' | 'on' | 'undecided';
export type ManualStatus = {
	state:
		'idle' | 'queued' | 'downloading' | 'waitingNetwork' | 'waitingOffline' | 'failed' | 'complete';
	total: number;
	saved: number;
	pending: number;
	failed: number;
	lastError: string;
	current?: Pick<PlayerTrack, 'id' | 'title' | 'artist'>;
	failures?: Array<Pick<PlayerTrack, 'id' | 'title' | 'artist'> & { reason: string }>;
};
export const nativeMedia = registerPlugin<
	OfflineBridge & {
		save(
			input: Parameters<OfflineBridge['save']>[0] & { transferId?: string; collection?: boolean }
		): Promise<void>;
		cancelTransfer(input: Account & { transferId: string }): Promise<void>;
		companion(
			owner: Account & { kind: 'artwork' | 'lyrics'; key: string }
		): Promise<{ source?: string }>;
		metadataTargets(
			owner: Account
		): Promise<{ targets: { id: string; album: string; version: string }[] }>;
		applyMetadata(
			input: Account & {
				token: string;
				transferId: string;
				updates: { version: string; track: PlayerTrack }[];
			}
		): Promise<{ updated: string[] }>;
		refreshMetadata(owner: Account & { observedIds: string[] }): Promise<{
			updated: number;
			unavailable: number;
			confirmed?: Record<string, { rating?: number; favorite?: boolean }>;
		}>;
		diagnostics(owner: Account): Promise<{ text: string }>;
		shareDiagnostics(input: Account & { text: string }): Promise<void>;
		saveDiagnostics(input: Account & { text: string }): Promise<{ saved: boolean }>;
		enqueueManual(batch: Account & { tracks: PlayerTrack[]; token?: string }): Promise<{
			saved: number;
			queued: number;
			alreadyQueued: number;
			failed: number;
			status: ManualStatus;
		}>;
		canSyncCollections(owner: Account): Promise<{ permitted: boolean }>;
		planCollections(
			input: Account & { pins: OfflinePin[]; source: DownloadSource; members: CollectionMember[] }
		): Promise<{ ids: string[] }>;
		syncCollections(owner: Account): Promise<{ saved: number; message?: string }>;
		disconnectDownloads(owner: Account): Promise<void>;
		resumeManual(owner: Account & { token: string }): Promise<void>;
		manualStatus(owner: Account): Promise<ManualStatus>;
		takeDownloadNotification(owner?: Account): Promise<{ open: boolean }>;
		downloadNotificationSettings(): Promise<{ state: DownloadNotificationState }>;
		openDownloadNotificationSettings(): Promise<void>;
		cancelManual(owner: Account): Promise<ManualStatus>;
		retryManual(owner: Account): Promise<ManualStatus>;
		historySettings(owner: Account): Promise<HistoryStatus>;
		setOfflineHistory(change: Account & { enabled: boolean }): Promise<HistoryStatus>;
		discardOfflineHistory(owner: Account): Promise<HistoryStatus>;
		addListener(
			event: 'historyChanged' | 'mediaChanged' | 'manualChanged',
			update: () => void
		): Promise<PluginListenerHandle>;
	}
>('DNOffline');
