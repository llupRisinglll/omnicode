import {spawn} from 'node:child_process';
import {Box, Text} from 'ink';
import React from 'react';
import {useTheme} from '@/hooks/useTheme';
import {generateKey} from '@/session/key-generator';
import type {Command} from '@/types/index';
import {infoMsg} from '@/utils/message-factory';
import {
	defaultPrScope,
	loadPrUrls,
	recordPrUrls,
	shouldCapturePrUrl,
} from '@/utils/pr-store';

/**
 * Opens every PR recorded in the out-of-band PR store in the default browser.
 * PR links are captured automatically as messages/tool results are committed
 * (see pr-store.ts / MessageBuilder), so the model never has to carry them in
 * context and this command stays a tiny lookup + spawn.
 */

function openUrlInBrowser(url: string): void {
	// Test hook: report without spawning a browser.
	if (process.env.NANOCODER_OPEN_PRS_DRY_RUN) return;

	if (process.platform === 'win32') {
		const child = spawn('cmd', ['/c', 'start', '', url], {
			detached: true,
			stdio: 'ignore',
		});
		child.unref();
		return;
	}

	const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
	const child = spawn(opener, [url], {detached: true, stdio: 'ignore'});
	child.unref();
}

function PrsOpenedMessage({urls}: {urls: string[]}) {
	const {colors} = useTheme();
	return (
		<Box marginY={1} flexDirection="column">
			<Text color={colors.success} bold>
				Opened {urls.length} PR
				{urls.length === 1 ? '' : 's'} in the browser:
			</Text>
			{urls.map(url => (
				<Text key={url} color={colors.info}>
					• {url}
				</Text>
			))}
		</Box>
	);
}

export const openPrsCommand: Command = {
	name: 'tool:open-prs',
	description: 'Open PRs created in this session in the default browser',
	handler: async (_args, messages) => {
		// Sweep the live transcript too, so PRs from resumed sessions (which
		// bypass the commit-time capture) are still found. Only creation-like
		// content counts — research that merely references an upstream PR does
		// not get recorded or opened.
		const scope = defaultPrScope();
		for (const message of messages) {
			if (
				shouldCapturePrUrl({
					role: message.role,
					name: message.name,
					content: message.content,
				})
			) {
				recordPrUrls(scope, message.content);
			}
		}

		const urls = loadPrUrls(scope);
		if (urls.length === 0) {
			return infoMsg(
				'No PRs found in this session yet. PR links are captured automatically when they appear in tool results.',
				'open-prs-empty',
			);
		}

		for (const url of urls) {
			openUrlInBrowser(url);
		}

		return React.createElement(PrsOpenedMessage, {
			key: generateKey('open-prs'),
			urls,
		});
	},
};
