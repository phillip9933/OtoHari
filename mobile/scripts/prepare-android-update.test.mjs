import assert from 'node:assert/strict';
import test from 'node:test';
import { checkVersionCode, signerFingerprint } from './prepare-android-update.mjs';

test('only the verified APK signer identifies the distribution certificate', () => {
	const digest = 'ab'.repeat(32);
	const signer = 'Signer #1 certificate SHA-256 digest: ' + digest;
	assert.equal(signerFingerprint('Signer #1 certificate DN: CN=fixture\n' + signer), digest);
	assert.throws(() =>
		signerFingerprint('Source Stamp Signer certificate SHA-256 digest: ' + digest)
	);
	assert.throws(() => signerFingerprint(signer + '\n' + signer.replace('#1', '#2')));
});

test('an update must match the source build and upgrade the last published code', () => {
	checkVersionCode(30, 30, 29);
	checkVersionCode(1, 1, 0);
	assert.throws(() => checkVersionCode(30, 31, 29));
	assert.throws(() => checkVersionCode(30, 30, 30));
	assert.throws(() => checkVersionCode(29, 29, 30));
});
