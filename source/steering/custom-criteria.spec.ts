import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {createCriterionChecker} from './steering-engine';
import type {TurnFact} from './types';

const project = mkdtempSync(join(tmpdir(), 'nanocoder-steering-criteria-'));
writeFileSync(join(project, 'ready.txt'), 'service ready\n');

const fact: TurnFact = {
	turnIndex: 0,
	wallClockMs: 0,
	toolCalls: [
		{id: 'a', function: {name: 'git_commit', arguments: {message: 'x'}}},
	],
	toolResults: [
		{
			tool_call_id: 'a',
			role: 'tool',
			name: 'git_commit',
			content: 'committed successfully',
		},
	],
	intentClass: 'commit',
	cwd: project,
	hadError: false,
};

test('custom success criteria inspect safe project state and turn facts', t => {
	const check = createCriterionChecker(() => project);
	t.true(check('fileExists:ready.txt', fact, [fact]));
	t.true(check('fileContains:ready.txt::service ready', fact, [fact]));
	t.true(check('toolSucceeded:git_commit', fact, [fact]));
	t.true(check('resultContains:committed successfully', fact, [fact]));
	t.true(check('gitChanged', fact, [fact]));
	t.false(check('fileExists:../outside.txt', fact, [fact]));
});
