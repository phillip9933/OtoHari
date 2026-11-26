declare const __OTOHARI_PLAY_BUILD__: boolean;

export const playBuild = __OTOHARI_PLAY_BUILD__;

// The Play build plays and saves media already in the connected library. It does
// not manage server-side acquisition jobs. Personal mix refresh is a library action.
export function serverAcquisitionRoute(path: string): boolean {
	const match = /(?:^|\/)api\/v3\/(requests|downloads)(?:\/|$)(.*)/.exec(path);
	return !!match && !(match[1] === 'requests' && match[2] === 'personal-mix/refresh');
}
