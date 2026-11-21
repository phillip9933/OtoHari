import japanese from './ja.json' with { type: 'json' };

const translations: Record<string, string> = japanese;
export function japaneseText(english: string) {
	return Object.hasOwn(translations, english) ? translations[english] : english;
}
