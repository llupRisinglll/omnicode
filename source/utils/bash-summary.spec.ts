import test from 'ava';
import {summarizeBashCommand} from './bash-summary';

console.log('\nbash-summary.spec.ts');

test('summarizes a simple command to its executable + first args', t => {
	t.is(summarizeBashCommand('npm run dev'), 'npm run dev');
	t.is(summarizeBashCommand('git status --short'), 'git status --short');
});

test('summarizes a chained command to the first real segment', t => {
	t.is(
		summarizeBashCommand('cd /tmp && npm install && npm run build'),
		'npm install',
	);
});

test('skips leading variable assignments', t => {
	t.is(
		summarizeBashCommand('X=1 Y=$(echo hi) && echo done && npm run dev'),
		'echo done',
	);
});

test('detects a poll loop and names the loop body command', t => {
	const cmd =
		'for i in $(seq 1 80); do kserp_deploy=$(gh run list --repo KahitSan/kserp --workflow deploy.yml) fin_rel=$(gh run list --repo KahitSan/kplugin_finance --workflow release.yml) if [ "$kserp_deploy" = "completed/success" ]; then break fi sleep 30 done';
	const label = summarizeBashCommand(cmd);
	t.true(label.startsWith('poll: '), `expected poll prefix, got "${label}"`);
	t.true(label.includes('gh run list'), `expected gh run list, got "${label}"`);
	t.true(label.length <= 60, `label too long: "${label}"`);
});

test('truncates long commands with an ellipsis', t => {
	const cmd =
		'gh-workflow-run-monitor --repository KahitSan/kserp --workflow deploy.yml';
	const label = summarizeBashCommand(cmd, 20);
	t.true(label.endsWith('…'), `expected ellipsis, got "${label}"`);
	t.true(label.length <= 21, `label too long: "${label}"`);
});

test('handles empty and whitespace-only commands', t => {
	t.is(summarizeBashCommand(''), '');
	t.is(summarizeBashCommand('   '), '');
});
