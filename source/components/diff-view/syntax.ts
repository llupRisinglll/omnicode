import chalk from 'chalk';
import {highlight, plain, type Theme} from 'cli-highlight';
import type {Colors} from '@/types/ui';
import {getLanguageFromExtension} from '@/utils/programming-language-helper';

/**
 * Map a file path to a `cli-highlight` language id via its extension.
 * Empty/unknown extensions fall through to `getLanguageFromExtension`'s own
 * default (plain text), which `highlightCode` handles safely either way.
 */
export function languageForPath(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	return getLanguageFromExtension(ext);
}

// cli-highlight themes are cheap to build but rebuilt on every render without
// a cache — key by the palette colors that feed the token styles.
const themeCache = new Map<string, Theme>();

const hexOrPlain = (color: string | undefined) =>
	color ? chalk.hex(color) : plain;

/**
 * A cli-highlight theme derived from the ACTIVE palette. cli-highlight's
 * default theme is a hardcoded vivid blue/red/cyan that clashes with the
 * diff view's red/green backgrounds (and every other colored surface).
 * Deriving the token colors from the app theme keeps the syntax highlighting
 * self-consistent: the diff background conveys add/remove, the code keeps
 * its own colors, and unmatched text uses the theme's text color.
 */
export function themeForColors(colors: Colors): Theme {
	const signature = [
		colors.primary,
		colors.secondary,
		colors.text,
		colors.info,
		colors.success,
		colors.error,
		colors.warning,
		colors.tool,
	].join('|');
	const cached = themeCache.get(signature);
	if (cached) return cached;

	const theme: Theme = {
		keyword: hexOrPlain(colors.primary),
		literal: hexOrPlain(colors.primary),
		built_in: hexOrPlain(colors.info),
		type: hexOrPlain(colors.info),
		class: hexOrPlain(colors.primary),
		function: hexOrPlain(colors.info),
		title: hexOrPlain(colors.info),
		number: hexOrPlain(colors.success),
		string: hexOrPlain(colors.warning),
		regexp: hexOrPlain(colors.error),
		comment: hexOrPlain(colors.secondary),
		meta: hexOrPlain(colors.secondary),
		section: hexOrPlain(colors.primary),
		tag: hexOrPlain(colors.primary),
		name: hexOrPlain(colors.info),
		attr: hexOrPlain(colors.info),
		attribute: hexOrPlain(colors.info),
		subst: plain,
		// Unmatched text keeps the theme's readable base color instead of the
		// diff line color, so the red/green never bleeds into the code.
		default: hexOrPlain(colors.text),
	};
	themeCache.set(signature, theme);
	return theme;
}

/**
 * Syntax-highlight a single line/segment of code, returning an ANSI-styled
 * string. Never throws — `cli-highlight` chokes on partial tokens (a lone
 * closing brace, a mid-string segment from word-diff splitting), so any
 * failure falls back to the original plain text, matching the try/catch
 * behavior `string-replace-preview.tsx` already relies on.
 */
export function highlightCode(
	text: string,
	language: string,
	colors?: Colors,
): string {
	if (text.length === 0) return text;
	try {
		return highlight(text, {
			language,
			theme: colors ? themeForColors(colors) : 'default',
		});
	} catch {
		return text;
	}
}
