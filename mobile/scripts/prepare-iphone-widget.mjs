import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Capacitor's iOS tooling already installs these project and plist parsers.
const require = createRequire(import.meta.url);
const cli = createRequire(require.resolve('@capacitor/cli/package.json'));
const xcode = cli('xcode');
const plist = cli('plist');
const app = fileURLToPath(new URL('../ios/App/', import.meta.url));
const file = (name) => path.join(app, name);
const original = file('App.xcodeproj/project.pbxproj');
const project = xcode.project(original);
project.parseSync();
const objects = project.hash.project.objects;
const { uuid: host, firstTarget: target } = project.getFirstTarget();
const hostName = 'AppWidgets.xcodeproj';
const extension = 'NowPlayingWidget';
const output = file(hostName);
const baseSettings = settings(host);
const hostBundle = process.argv[2] ?? baseSettings[0].PRODUCT_BUNDLE_IDENTIFIER;
if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/.test(hostBundle)) {
	throw Error('Supply a reverse-DNS iPhone app bundle identifier in lowercase.');
}
const entitlements = 'NowPlayingWidget/Shared.entitlements';
const quote = JSON.stringify;
function settings(id) {
	const list = objects.XCConfigurationList[objects.PBXNativeTarget[id].buildConfigurationList];
	return list.buildConfigurations.map(
		({ value }) => objects.XCBuildConfiguration[value].buildSettings
	);
}

const used = new Set(Object.values(objects).flatMap((section) => Object.keys(section)));
let sequence = 0;
project.generateUuid = () => {
	let id;
	do {
		id = createHash('sha256')
			.update('DNNowPlayingWidget-' + sequence++)
			.digest('hex')
			.slice(0, 24)
			.toUpperCase();
	} while (used.has(id));
	used.add(id);
	return id;
};
objects.PBXContainerItemProxy ??= {};
objects.PBXTargetDependency ??= {};
const { uuid: widget } = project.addTarget(
	extension,
	'app_extension',
	extension,
	hostBundle + '.' + extension
);
// Explicit SOURCE_ROOT paths avoid creating a second App group or assuming Xcode's navigator placement.
function addFiles(phaseType, title, files) {
	const phase = project.addBuildPhase([], phaseType, title, widget).buildPhase;
	const group = objects.PBXGroup[project.getFirstProject().firstProject.mainGroup];
	for (const [filename, filetype] of files) {
		let ref = Object.entries(objects.PBXFileReference).find(
			([, entry]) =>
				typeof entry?.path === 'string' &&
				entry.path.replaceAll('"', '') === path.basename(filename)
		)?.[0];
		if (!ref) {
			ref = project.generateUuid();
			const short = path.basename(filename);
			objects.PBXFileReference[ref] = {
				isa: 'PBXFileReference',
				lastKnownFileType: filetype,
				name: short,
				path: quote(filename),
				sourceTree: 'SOURCE_ROOT'
			};
			objects.PBXFileReference[ref + '_comment'] = short;
			group.children.push({ value: ref, comment: short });
		}
		const build = project.generateUuid();
		objects.PBXBuildFile[build] = { isa: 'PBXBuildFile', fileRef: ref, fileRef_comment: filename };
		objects.PBXBuildFile[build + '_comment'] = filename + ' in ' + title;
		phase.files.push({ value: build, comment: filename });
	}
}
addFiles('PBXSourcesBuildPhase', 'Sources', [
	['App/PlayerWidgetSnapshot.swift', 'sourcecode.swift'],
	['NowPlayingWidget/NowPlayingWidget.swift', 'sourcecode.swift']
]);
addFiles('PBXResourcesBuildPhase', 'Resources', [
	['NowPlayingWidget/Localizable.xcstrings', 'text.json.xcstrings']
]);
const product = objects.PBXFileReference[objects.PBXNativeTarget[widget].productReference];
delete product.fileEncoding;
delete product.lastKnownFileType;
for (const s of baseSettings) {
	Object.assign(s, {
		CODE_SIGN_ENTITLEMENTS: entitlements,
		DN_WIDGET_HOST_ID: hostBundle,
		PRODUCT_BUNDLE_IDENTIFIER: hostBundle,
		INFOPLIST_FILE: hostName + '/WidgetHost-Info.plist',
		SWIFT_ACTIVE_COMPILATION_CONDITIONS: quote(
			(s.SWIFT_ACTIVE_COMPILATION_CONDITIONS ?? '').replaceAll('"', '') + ' DN_PLAYER_WIDGET'
		)
	});
}
for (const s of settings(widget)) {
	Object.assign(s, {
		APPLICATION_EXTENSION_API_ONLY: 'YES',
		CODE_SIGN_STYLE: 'Automatic',
		CODE_SIGN_ENTITLEMENTS: entitlements,
		DN_WIDGET_HOST_ID: hostBundle,
		INFOPLIST_FILE: extension + '/Info.plist',
		IPHONEOS_DEPLOYMENT_TARGET: '16.4',
		MARKETING_VERSION: baseSettings[0].MARKETING_VERSION,
		CURRENT_PROJECT_VERSION: baseSettings[0].CURRENT_PROJECT_VERSION,
		SWIFT_ACTIVE_COMPILATION_CONDITIONS: quote('$(inherited) DN_PLAYER_WIDGET'),
		SWIFT_VERSION: '5.0',
		TARGETED_DEVICE_FAMILY: '"1,2"'
	});
}
const embedded = target.buildPhases
	.map(({ value }) => objects.PBXCopyFilesBuildPhase?.[value])
	.find((phase) =>
		phase?.files.some(
			({ value }) =>
				objects.PBXBuildFile[value].fileRef === objects.PBXNativeTarget[widget].productReference
		)
	);
if (
	!embedded ||
	Number(embedded.dstSubfolderSpec) !== 13 ||
	!target.dependencies.some(({ value }) => objects.PBXTargetDependency[value].target === widget)
) {
	throw Error('Could not attach the widget to the iPhone app.');
}
for (const build of embedded.files)
	objects.PBXBuildFile[build.value].settings = { ATTRIBUTES: ['RemoveHeadersOnCopy'] };
const targets = project.getFirstProject().firstProject.attributes.TargetAttributes;
for (const id of [host, widget]) {
	targets[id] ??= {};
	targets[id].SystemCapabilities ??= {};
	targets[id].SystemCapabilities['com.apple.ApplicationGroups.iOS'] = { enabled: 1 };
}
mkdirSync(output, { recursive: true });
const swiftLock = 'project.xcworkspace/xcshareddata/swiftpm/Package.resolved';
mkdirSync(path.dirname(path.join(output, swiftLock)), { recursive: true });
copyFileSync(file(path.join('App.xcodeproj', swiftLock)), path.join(output, swiftLock));
const hostInfo = plist.parse(readFileSync(file('App/Info.plist'), 'utf8'));
hostInfo.CFBundleURLTypes.push({ CFBundleURLSchemes: [hostBundle + '.widgets'] });
writeFileSync(path.join(output, 'WidgetHost-Info.plist'), plist.build(hostInfo));
writeFileSync(path.join(output, 'project.pbxproj'), project.writeSync());
const schemes = path.join(output, 'xcshareddata/xcschemes');
mkdirSync(schemes, { recursive: true });
const appRef =
	'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="' +
	host +
	'" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:' +
	hostName +
	'"/>';
writeFileSync(
	path.join(schemes, 'App.xcscheme'),
	`<?xml version="1.0" encoding="UTF-8"?>
<Scheme version="1.7">
 <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
  <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${appRef}</BuildActionEntry>
 </BuildActionEntries></BuildAction>
 <TestAction buildConfiguration="Debug"/>
 <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0">
  <BuildableProductRunnable runnableDebuggingMode="0">${appRef}</BuildableProductRunnable>
 </LaunchAction>
 <ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">${appRef}</BuildableProductRunnable></ProfileAction>
 <AnalyzeAction buildConfiguration="Debug"/>
 <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`
);
console.log(
	'Widget project ready at ' +
		output +
		'. Use scheme App and the shared group group.' +
		hostBundle +
		'.'
);
