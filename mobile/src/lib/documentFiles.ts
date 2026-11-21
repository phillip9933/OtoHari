import { registerPlugin } from '@capacitor/core';

interface Headers {
	contentDisposition?: string;
	skippedTracks?: string;
}
export const nativeDocuments = registerPlugin<{
	prepare(opts: {
		id: string;
		serverUrl: string;
		url: string;
		token: string;
		format: 'm3u8' | 'csv';
	}): Promise<Headers>;
	save(opts: { id: string; filename: string }): Promise<{ saved: boolean }>;
	saveDiagnostics(input: {
		serverUrl: string;
		userId: string;
		text: string;
	}): Promise<{ saved: boolean }>;
	shareDiagnostics(input: { serverUrl: string; userId: string; text: string }): Promise<void>;
	saveLayout(opts: { text: string }): Promise<{ saved: boolean }>;
	discard(opts: { id: string }): Promise<void>;
}>('DNPlaylistExport');

export function downloadFile(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.append(a);
	try {
		a.click();
	} finally {
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	}
}
