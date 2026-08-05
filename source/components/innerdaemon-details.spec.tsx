import test from 'ava';
import React from 'react';
import {renderWithTheme} from '../test-utils/render-with-theme';
import {
	clearScreen,
	setTerminalSize,
	writeString,
} from '../utils/selection';
import {clickEvents} from '../utils/terminal-mouse';
import InnerDaemonDetails from './innerdaemon-details';

console.log(`\ninnerdaemon-details.spec.tsx – ${React.version}`);

test('InnerDaemonDetails renders the glyph header + nudge body (light)', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="Use the verified scripts. Do not hand-roll the worktree." />,
	);
	const out = lastFrame();
	t.truthy(out);
	t.regex(out!, /◆ InnerDaemon/);
	t.regex(out!, /Use the verified scripts/);
});

test('InnerDaemonDetails shows ruleId when provided', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="nudge" ruleId="worktree-supervision" />,
	);
	t.regex(lastFrame()!, /worktree-supervision/);
});

test('InnerDaemonDetails firm urgency shows the steering marker', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="Stop hand-rolling." urgency="firm" />,
	);
	const out = lastFrame()!;
	t.regex(out, /◆ InnerDaemon/);
	t.regex(out, /steering/);
	t.regex(out, /Stop hand-rolling/);
});

test('InnerDaemonDetails light urgency omits the steering marker', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="gentle nudge" urgency="light" />,
	);
	const out = lastFrame()!;
	t.regex(out, /◆ InnerDaemon/);
	// "steering" marker only appears on firm urgency
	t.notRegex(out, /\(steering\)/);
});

test('InnerDaemonDetails renders multi-sentence markdown without throwing', t => {
	const msg =
		'You appear stuck on runtime setup. Decide now: get the server up, or report BLOCKER and stop. Do not try another launch strategy.';
	const {lastFrame} = renderWithTheme(<InnerDaemonDetails message={msg} />);
	t.regex(lastFrame()!, /runtime setup/);
	t.regex(lastFrame()!, /BLOCKER/);
});

const LONG_ANNOUNCE_MESSAGE = [
	'Line one: this skill is the detail behind the local-dev workflow.',
	'Line two: boot commands, dev accounts, and test layout.',
	'Line three: the worktree invariants live here.',
	'Line four: kernel alone boots UI :4000 and API :4001.',
	'Line five: kernel plus one plugin uses KSERP_PLUGINS.',
	'Line six: dev accounts share password password.',
	'Line seven: two orgs — KahitSan and Naga Coworks.',
	'Line eight: never kill the dev server after a verify.',
].join('\n');

test('long announce bodies collapse to the first 3 lines with a +N more lines button', t => {
	// Regression surface for the `hilinga-local-dev-skill` announce: the full
	// skill body used to render in full, flooding the transcript. It must now
	// collapse like a Write() file result.
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails
			message={LONG_ANNOUNCE_MESSAGE}
			ruleId="hilinga-local-dev-skill"
		/>,
	);
	const out = lastFrame()!;
	t.regex(out, /◆ InnerDaemon/);
	t.regex(out, /hilinga-local-dev-skill/);
	t.regex(out, /Line one:/);
	t.regex(out, /Line three:/);
	t.regex(out, /\+5 more lines/);
	// The "+N more lines" footer is the expand button — it must carry the
	// same hint every other expandable footer shows.
	t.regex(out, /\(ctrl \+ t to view transcript\)/);
	t.notRegex(out, /Line eight:/);
});

test('expanded prop reveals the full body and hides the collapse footer', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message={LONG_ANNOUNCE_MESSAGE} expanded />,
	);
	const out = lastFrame()!;
	t.regex(out, /Line eight:/);
	t.notRegex(out, /more lines/);
});

test('short nudges stay fully visible — no collapse footer', t => {
	const {lastFrame} = renderWithTheme(
		<InnerDaemonDetails message="Use the verified scripts. Do not hand-roll the worktree." />,
	);
	const out = lastFrame()!;
	t.regex(out, /Use the verified scripts/);
	t.notRegex(out, /more lines/);
});

test('long announce body expands on footer click WITHOUT an expanded prop (live queue path)', async t => {
	setTerminalSize(80, 24);
	const {lastFrame, unmount} = renderWithTheme(
		<InnerDaemonDetails message={LONG_ANNOUNCE_MESSAGE} />,
	);
	await new Promise(resolve => setTimeout(resolve, 50));

	const collapsed = lastFrame()!;
	t.regex(collapsed, /\+5 more lines/);
	t.notRegex(collapsed, /Line eight:/);

	// Seed the screen snapshot like the output overlay would and click the
	// "+N more lines" footer. Regression: the live chat queues the block
	// WITHOUT the `expanded` prop, so the base/value comparison used to fail
	// and the click was a no-op.
	clearScreen();
	writeString(3, 0, '    … +5 more lines (ctrl + t to view transcript)');
	clickEvents.emit('click', {x: 6, y: 3});
	await new Promise(resolve => setTimeout(resolve, 50));
	t.regex(lastFrame()!, /Line eight:/, 'footer click should expand the body');
	unmount();
});
