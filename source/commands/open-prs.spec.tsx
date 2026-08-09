import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import React from 'react';
import stripAnsi from 'strip-ansi';
import {renderWithTheme} from '../test-utils/render-with-theme.js';
import {openPrsCommand} from './open-prs.js';
import {clearPrUrls, defaultPrScope, recordPrUrls} from '@/utils/pr-store';

const configDir = mkdtempSync(join(tmpdir(), 'nanocoder-open-prs-spec-'));
process.env.NANOCODER_CONFIG_DIR = configDir;
process.env.NANOCODER_OPEN_PRS_DRY_RUN = '1';

test.after(() => {
	rmSync(configDir, {recursive: true, force: true});
});

test('tool:open-prs lists stored PRs in the returned notice', async t => {
	clearPrUrls();
	recordPrUrls(defaultPrScope(), 'https://github.com/acme/app/pull/7');

	const element = await openPrsCommand.handler([], [
		{role: 'user', content: 'ignore me'},
	]);
	t.true(React.isValidElement(element));

	const {lastFrame, unmount} = renderWithTheme(element as React.ReactElement);
	const output = stripAnsi(lastFrame()!);
	t.regex(output, /Opened 1 PR/);
	t.regex(output, /https:\/\/github\.com\/acme\/app\/pull\/7/);
	unmount();
});

test('tool:open-prs sweeps the transcript for PRs not yet recorded', async t => {
	clearPrUrls();

	const element = await openPrsCommand.handler([], [
		{
			role: 'assistant',
			content: 'I created PR https://github.com/acme/app/pull/42',
		},
	]);
	t.true(React.isValidElement(element));

	const {lastFrame, unmount} = renderWithTheme(element as React.ReactElement);
	const output = stripAnsi(lastFrame()!);
	t.regex(output, /https:\/\/github\.com\/acme\/app\/pull\/42/);
	unmount();
});

test('tool:open-prs ignores PRs merely referenced during research', async t => {
	clearPrUrls();

	const element = await openPrsCommand.handler([], [
		{
			role: 'tool',
			name: 'web_search',
			content:
				'# Web Search Results\nSee https://github.com/payloadcms/payload/pull/8354',
		},
	]);
	t.true(React.isValidElement(element));

	const {lastFrame, unmount} = renderWithTheme(element as React.ReactElement);
	const output = stripAnsi(lastFrame()!);
	t.regex(output, /No PRs found/);
	unmount();
});

test('tool:open-prs reports when no PRs were found', async t => {
	clearPrUrls();

	const element = await openPrsCommand.handler([], [
		{role: 'user', content: 'nothing here'},
	]);
	t.true(React.isValidElement(element));

	const {lastFrame, unmount} = renderWithTheme(element as React.ReactElement);
	const output = stripAnsi(lastFrame()!);
	t.regex(output, /No PRs found/);
	unmount();
});
