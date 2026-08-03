import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {render} from 'ink-testing-library';
import React from 'react';
import test from 'ava';
import {themes} from '../config/themes';
import {ThemeContext} from '../hooks/useTheme';
import {resetPreferencesCache, updateVisionModel} from '@/config/preferences';
import type {ImageAttachment, LLMClient, Message} from '@/types/core';
import {
	setArchiveRootOverride,
	persistDescription,
	persistImages,
} from '@/utils/attachment-archive';
import {
	examineImageFormatter,
	examineImageTool,
	examineImageValidator,
	executeExamineImage,
	setVisionClientFactoryForTests,
} from './examine-image';

console.log(`\nexamine-image.spec.tsx – ${React.version}`);

// Isolate config so getVisionModel() reads a clean preferences file — set
// before any preference is loaded (imports below are side-effect-lazy).
const testConfigDir = join(tmpdir(), `nc-examine-config-${Date.now()}`);
process.env.NANOCODER_CONFIG_DIR = testConfigDir;

const VISION_MODEL = 'fake-vision-model';

function image(content: string): ImageAttachment {
	return {data: Buffer.from(content).toString('base64'), mediaType: 'image/png'};
}

// Fake vision client that records the conversation it is handed and emits one
// token per call, so tests can assert both the answer and the "resume"
// accumulation of context.
let capturedMessages: Message[] = [];
const fakeVisionClient = {
	getCurrentModel: () => VISION_MODEL,
	setModel: () => {},
	getContextSize: () => 8000,
	getAvailableModels: async () => [],
	getProviderConfig: () => ({name: 'fake-provider'}) as never,
	chat: async (
		messages: Message[],
		_tools: unknown,
		callbacks: {onToken?: (token: string) => void},
	): Promise<unknown> => {
		capturedMessages = messages;
		callbacks.onToken?.('detailed answer');
		return {content: 'detailed answer'};
	},
	clearContext: async () => {},
	getTimeout: () => undefined,
} as unknown as LLMClient;

test.before(async () => {
	// Fresh config dir with a vision model configured.
	resetPreferencesCache();
	updateVisionModel(VISION_MODEL);
});

test.beforeEach(async () => {
	const archiveDir = await mkdtemp(join(tmpdir(), 'nc-examine-archive-'));
	await setArchiveRootOverride(archiveDir);
	capturedMessages = [];
	setVisionClientFactoryForTests(async () => fakeVisionClient);
});

test.after(() => {
	setVisionClientFactoryForTests(async (model, provider) => {
		const {createVisionClient} = await import('@/models/vision');
		return createVisionClient(model, provider);
	});
});

// --- Validator ---

test('validator requires a positive integer index', async t => {
	t.is((await examineImageValidator({index: 0})).valid, false);
	t.is((await examineImageValidator({index: -1})).valid, false);
	t.is((await examineImageValidator({index: 1.5})).valid, false);
	t.true((await examineImageValidator({index: 2})).valid);
});

test('validator caps the question length', async t => {
	const long = 'x'.repeat(2001);
	t.is((await examineImageValidator({index: 1, question: long})).valid, false);
	t.true(
		(await examineImageValidator({index: 1, question: 'short'})).valid,
	);
});

// --- Handler error paths (no vision client needed) ---

test('handler rejects a non-positive index', async t => {
	const result = await executeExamineImage({index: 0});
	t.true(result.startsWith('examine_image: index must be a positive integer'));
});

test('handler reports an image that is not archived', async t => {
	const result = await executeExamineImage({index: 5});
	t.true(result.startsWith('examine_image: image #5 is not available'));
});

test('handler reports when no image has been archived yet', async t => {
	const result = await executeExamineImage({index: 1});
	t.true(result.startsWith('examine_image: image #1 is not available'));
});

test('handler reports when no vision model is configured', async t => {
	await persistImages([image('x')]);
	resetPreferencesCache();
	updateVisionModel(null);
	const result = await executeExamineImage({index: 1});
	t.true(result.startsWith('examine_image: no vision model is configured'));
	// Restore for subsequent tests.
	updateVisionModel(VISION_MODEL);
});

// --- Handler success path ---

test('handler asks the vision model and returns its answer', async t => {
	await persistImages([image('screenshot bytes')]);
	await persistDescription('Prior analysis: a login form with an error banner.');

	const result = await executeExamineImage({
		index: 1,
		question: 'Read the error banner text verbatim.',
	});

	t.is(result, `Vision re-examination of image #1 (${VISION_MODEL}):\ndetailed answer`);

	// The seeded conversation carries the image, the prior analysis, and the
	// targeted question — a resume, not a fresh description.
	const seed = capturedMessages[0];
	t.is(seed.role, 'user');
	t.truthy(seed.images);
	t.is(seed.images!.length, 1);
	t.true(seed.content.includes('Prior analysis: a login form'));
	t.is(capturedMessages[1].content, 'Read the error banner text verbatim.');
	// The handler appends the assistant answer to the same array.
	t.is(capturedMessages[2].role, 'assistant');
});

test('handler accumulates context across follow-ups (resume)', async t => {
	await persistImages([image('screenshot bytes')]);
	await persistDescription('Prior analysis.');

	await executeExamineImage({index: 1, question: 'first question'});
	// seed + q1 + a1 — the handler already appended the assistant answer.
	t.is(capturedMessages.length, 3);
	t.is(capturedMessages[1].content, 'first question');
	t.is(capturedMessages[2].role, 'assistant');

	await executeExamineImage({index: 1, question: 'second question'});
	// seed + q1 + a1 + q2 + a2 — the second call resumed the first conversation.
	t.is(capturedMessages.length, 5);
	t.is(capturedMessages[3].content, 'second question');
	t.is(capturedMessages[4].role, 'assistant');
});

test('handler seeds with a generic prompt when no description exists', async t => {
	await persistImages([image('screenshot bytes')]);

	await executeExamineImage({index: 1});
	const seed = capturedMessages[0];
	t.true(seed.content.startsWith('You are a meticulous image analyst'));
	t.true(
		capturedMessages[1].content.startsWith('Describe image #1 in more detail'),
	);
});

// --- Formatter ---

const MockThemeProvider = ({children}: {children: React.ReactNode}) => {
	const mockTheme = {
		currentTheme: 'default' as const,
		colors: themes['tokyo-night'].colors,
		setCurrentTheme: () => {},
	};
	return (
		<ThemeContext.Provider value={mockTheme}>{children}</ThemeContext.Provider>
	);
};

test('formatter renders the image index and question', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			{examineImageFormatter({index: 2, question: 'Read the dialog'})}
		</MockThemeProvider>,
	);
	t.true(lastFrame()!.includes('examine_image'));
	t.true(lastFrame()!.includes('image #2'));
	t.true(lastFrame()!.includes('Read the dialog'));
});

test('formatter renders the result token estimate', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			{examineImageFormatter(
				{index: 1},
				'a vision answer',
			)}
		</MockThemeProvider>,
	);
	t.true(lastFrame()!.includes('Answer:'));
});

// Tool export shape
test('tool is read-only and registered under examine_image', t => {
	t.is(examineImageTool.name, 'examine_image');
	t.true(examineImageTool.readOnly);
	t.truthy(examineImageTool.tool);
});
