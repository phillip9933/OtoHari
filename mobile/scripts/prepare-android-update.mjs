import { execFileSync } from 'node:child_process';
import {
	constants,
	copyFileSync,
	createWriteStream,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const maxBytes = 512 * 1024 * 1024;
const repository = 'phillip9933/DroppedNeedle';

export function signerFingerprint(verification) {
	const signers = [
		...verification.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f]{64})\s*$/gim)
	];
	if (signers.length !== 1) throw Error('Expected one APK signing certificate.');
	return signers[0][1].toLowerCase();
}

function inspect(apk, tools, expectedSigner, version) {
	if (statSync(apk).size > maxBytes) throw Error('The updater accepts APKs up to 512 MiB.');
	const output = execFileSync(
		'java',
		['-jar', join(tools, 'lib', 'apksigner.jar'), 'verify', '--print-certs', apk],
		{ encoding: 'utf8' }
	);
	if (signerFingerprint(output) !== expectedSigner)
		throw Error('The APK signing certificate differs from the trusted release certificate.');
	const badging = execFileSync(
		join(tools, process.platform === 'win32' ? 'aapt.exe' : 'aapt'),
		['dump', 'badging', apk],
		{ encoding: 'utf8' }
	);
	const pkg = badging.split('\n').find((line) => line.startsWith('package:')) ?? '';
	if (
		!pkg.includes(" name='app.droppedneedle.mobile'") ||
		!pkg.includes(` versionName='${version}'`)
	)
		throw Error(`Expected app.droppedneedle.mobile version ${version}.`);
	const code = Number(/ versionCode='([1-9]\d*)'/.exec(pkg)?.[1]);
	if (!Number.isSafeInteger(code) || / split=/.test(pkg) || /^uses-split:/m.test(badging))
		throw Error('Choose the standalone APK with a positive version code.');
	if (/^application-debuggable(?:\s|$)/m.test(badging))
		throw Error('The APK is debuggable. Choose the signed release build.');
	return code;
}

export function checkVersionCode(candidate, configured, published) {
	if (candidate !== configured)
		throw Error('The APK version code must match mobile/android/app/build.gradle.');
	if (candidate <= published)
		throw Error(`Increase the version code above the last published Android build (${published}).`);
}

async function latestPublished() {
	let latest;
	for (let page = 1; ; page++) {
		const response = await fetch(
			`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
			{
				headers: { Accept: 'application/vnd.github+json' },
				signal: AbortSignal.timeout(30_000)
			}
		);
		if (!response.ok)
			throw Error(`Could not check published Android releases (HTTP ${response.status}).`);
		const releases = await response.json();
		for (const release of releases) {
			if (release.draft || !release.published_at || !release.tag_name.startsWith('android-v'))
				continue;
			const version = release.tag_name.slice('android-v'.length);
			const asset = release.assets.find(
				(item) => item.name === `droppedneedle-android-${version}.apk`
			);
			if (asset && (!latest || release.published_at > latest.date))
				latest = { version, date: release.published_at, asset };
		}
		if (releases.length < 100) return latest;
	}
}

async function publishedCode(tools, signer) {
	const latest = await latestPublished();
	if (!latest) return 0;
	const { version, asset } = latest;
	const expected = `https://github.com/${repository}/releases/download/${encodeURIComponent('android-v' + version)}/${encodeURIComponent(asset.name)}`;
	if (
		asset.browser_download_url !== expected ||
		!Number.isSafeInteger(asset.size) ||
		asset.size <= 0 ||
		asset.size > maxBytes
	)
		throw Error('The previous Android release has invalid APK metadata.');
	const folder = mkdtempSync(join(tmpdir(), 'dn-android-baseline-'));
	try {
		const previous = join(folder, 'previous.apk');
		const response = await fetch(expected, { signal: AbortSignal.timeout(180_000) });
		if (!response.ok || !response.body)
			throw Error('Could not download the prior public Android release.');
		let received = 0;
		await pipeline(
			response.body,
			async function* (source) {
				for await (const chunk of source) {
					received += chunk.length;
					if (received > asset.size) throw Error('The prior APK exceeded its published size.');
					yield chunk;
				}
			},
			createWriteStream(previous, { flags: 'wx' })
		);
		if (received !== asset.size) throw Error('The prior APK was incomplete.');
		return inspect(previous, tools, signer, version);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

async function prepare(input, directory) {
	if (!input || !directory || process.argv.length !== 4)
		throw Error('Usage: pnpm android:prepare-update <signed APK> <output directory>');
	const signer = (process.env.DN_ANDROID_RELEASE_CERT_SHA256 ?? '')
		.replaceAll(':', '')
		.trim()
		.toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(signer))
		throw Error(
			'Set DN_ANDROID_RELEASE_CERT_SHA256 to the trusted public distribution certificate fingerprint.'
		);
	const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
	if (!sdk) throw Error('Set ANDROID_HOME to your Android SDK directory.');
	const toolsRoot = join(sdk, 'build-tools');
	const toolsVersion = readdirSync(toolsRoot)
		.filter((name) => /^\d+\.\d+\.\d+$/.test(name))
		.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0];
	if (!toolsVersion) throw Error('Install Android SDK Build Tools first.');
	const tools = join(toolsRoot, toolsVersion);
	const apk = resolve(input);
	const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
	const configured = Number(/^\s*versionCode\s+([1-9]\d*)\s*$/m.exec(gradle)?.[1]);
	const candidate = inspect(apk, tools, signer, version);
	checkVersionCode(candidate, configured, await publishedCode(tools, signer));
	const asset = `droppedneedle-android-${version}.apk`;
	mkdirSync(directory, { recursive: true });
	const output = resolve(directory, asset);
	if (apk !== output) copyFileSync(apk, output, constants.COPYFILE_EXCL);
	console.log(`GitHub tag: android-v${version}\nRelease asset: ${output}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		await prepare(process.argv[2], process.argv[3]);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
