import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import type {ImageAttachment} from '@/types/core';
import {PlaceholderType} from '@/types/hooks';
import {
	getArchiveDirPath,
	getConversationKey,
	persistDescription,
	persistImages,
	persistPastes,
	readImageAttachment,
	readStoredDescription,
	resetAttachmentArchive,
	setArchiveRootOverride,
} from './attachment-archive';

console.log(`\nattachment-archive.spec.ts`);

// Each test gets a fresh, isolated archive root so module state never leaks
// between cases (the real tmpdir archive is never touched).
test.beforeEach(async () => {
	const dir = await mkdtemp(join(tmpdir(), 'nc-archive-'));
	await setArchiveRootOverride(dir);
});

function image(content: string, mediaType = 'image/png'): ImageAttachment {
	return {data: Buffer.from(content).toString('base64'), mediaType};
}

test('persistImages writes files with a global seq and a token manifest', async t => {
	const [a, b] = await persistImages([
		image('first image bytes'),
		image('second image bytes'),
	]);

	t.is(a.token, 1);
	t.is(a.seq, 1);
	t.is(b.token, 2);
	t.is(b.seq, 2);

	const dir = getArchiveDirPath();
	// Round-trips back through readImageAttachment by token.
	const one = await readImageAttachment(1);
	t.truthy(one);
	t.is(one!.image.data, Buffer.from('first image bytes').toString('base64'));
	t.is(one!.image.mediaType, 'image/png');
	t.is(one!.image.source, 'img-1.png');
	t.is(one!.seq, 1);

	const two = await readImageAttachment(2);
	t.truthy(two);
	t.is(two!.image.data, Buffer.from('second image bytes').toString('base64'));

	// Manifest reflects the submission.
	const manifest = JSON.parse(
		await readFile(join(dir, 'latest-manifest.json'), 'utf8'),
	) as Array<{token: number; seq: number; mediaType: string}>;
	t.deepEqual(manifest, [
		{token: 1, seq: 1, mediaType: 'image/png'},
		{token: 2, seq: 2, mediaType: 'image/png'},
	]);
});

test('a later submission continues the seq and replaces the manifest', async t => {
	await persistImages([image('first message')]);
	await persistImages([image('second message'), image('third message')]);

	// Token numbers restart at 1 per submission; the physical seq keeps growing
	// so no filename collides with the earlier submission's img-1.
	const two = await readImageAttachment(1);
	t.truthy(two);
	t.is(two!.seq, 2);
	t.is(two!.image.data, Buffer.from('second message').toString('base64'));

	const three = await readImageAttachment(2);
	t.truthy(three);
	t.is(three!.seq, 3);
	t.is(three!.image.data, Buffer.from('third message').toString('base64'));

	// Token 3 is not in the latest manifest (it only covers the latest submission).
	t.is(await readImageAttachment(3), null);
});

test('readImageAttachment rejects invalid or missing tokens', async t => {
	await persistImages([image('only one')]);

	t.is(await readImageAttachment(0), null);
	t.is(await readImageAttachment(1.5), null);
	t.is(await readImageAttachment(2), null);
});

test('persistPastes writes a plain-text copy of each pasted block', async t => {
	await persistPastes({
		p1: {
			type: PlaceholderType.PASTE,
			content: 'hello world',
			displayText: '[Paste #1: 11 chars]',
			originalSize: 11,
		},
		p2: {
			type: PlaceholderType.PASTE,
			content: 'second paste',
			displayText: '[Paste #2: 12 chars]',
			originalSize: 12,
		},
	});

	const dir = getArchiveDirPath();
	t.is(await readFile(join(dir, 'paste-1.txt'), 'utf8'), 'hello world');
	t.is(await readFile(join(dir, 'paste-2.txt'), 'utf8'), 'second paste');
});

test('persistDescription / readStoredDescription round-trip', async t => {
	t.is(await readStoredDescription(), null);

	await persistDescription('The image shows a login form.');
	t.is(
		await readStoredDescription(),
		'The image shows a login form.',
	);

	// Blank descriptions are ignored.
	await persistDescription('   ');
	t.is(
		await readStoredDescription(),
		'The image shows a login form.',
	);
});

test('resetAttachmentArchive clears files and mints a fresh key', async t => {
	await persistImages([image('gone after reset')]);
	const oldKey = getConversationKey();
	const oldDir = getArchiveDirPath();
	t.truthy(await readImageAttachment(1));

	await resetAttachmentArchive();

	t.not(getConversationKey(), oldKey);
	t.not(getArchiveDirPath(), oldDir);
	t.is(await readImageAttachment(1), null);
	t.is(await readStoredDescription(), null);

	// The old directory was removed from disk.
	await t.throwsAsync(readFile(join(oldDir, 'img-1.png')));
});
