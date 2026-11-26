import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverAcquisitionRoute } from '../src/lib/distribution.ts';

test('Play route guard classifies user-library, server acquisitions and personal mixes', () => {
	for (const route of [
		'/api/v3/requests/tracks',
		'/dn/api/v3/requests/approvals/batches',
		'/dn/api/v3/downloads/tasks/task-1/retry',
		'/api/v3/playlists/list-1/request-state',
		'/api/v3/playlists/list-1/request-missing',
		'/api/v3/playlists/list-1/tracks/track-1/request-song'
	]) assert.equal(serverAcquisitionRoute(route), true, route);
	for (const route of [
		'/api/v3/library/tracks',
		'/api/v3/playlists/list-1',
		'/api/v3/playlists/list-1/tracks',
		'/api/v3/requests/personal-mix/refresh'
	]) assert.equal(serverAcquisitionRoute(route), false, route);
});
