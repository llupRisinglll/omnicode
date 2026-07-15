import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Colors, Theme, ThemePreset} from '@/types/ui';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load themes from JSON at startup — keeps 50 theme definitions out of source code.
// Path resolves from dist/config/ back to source/config/themes.json (included in package.json files).
const themesPath = join(__dirname, '../../source/config/themes.json');
export const themes: Record<ThemePreset, Theme> = JSON.parse(
	readFileSync(themesPath, 'utf-8'),
);

export function getThemeColors(themePreset: ThemePreset) {
	return themes[themePreset].colors;
}

export const defaultTheme: ThemePreset = 'omnicode';

// Background for chat/input text boxes. 'none' means the theme wants the
// terminal's own background (Ink omits the bg entirely when undefined).
export function getTextboxBackground(colors: Colors): string | undefined {
	if (colors.textboxBackground === 'none') return undefined;
	return colors.textboxBackground ?? colors.base;
}
