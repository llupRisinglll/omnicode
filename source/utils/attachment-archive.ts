import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ImageAttachment} from '@/types/core';
import type {InputState} from '@/types/hooks';
import {PlaceholderType} from '@/types/hooks';
import {getShutdownManager} from '@/utils/shutdown';

/**
 * Per-conversation attachment archive.
 *
 * Images and pasted text attached during a conversation are written to
 * `${tmpdir()}/nanocoder/attachments/<conversation-key>/` so the original can
 * be re-examined when the vision-fallback description isn't detailed enough.
 * The `examine_image` tool reads images back through the manifest, and the
 * user gets the directory path in the fallback status message.
 *
 * The archive is ephemeral by design ("temporary folder for the current
 * conversation"): the key is a UUID regenerated on `/clear`, and the OS
 * reclaims `tmpdir` on reboot. Cross-restart persistence is out of scope.
 */
const ATTACHMENTS_DIR_NAME = 'attachments';
const LATEST_MANIFEST_NAME = 'latest-manifest.json';
const DESCRIPTION_NAME = 'description.txt';

let conversationKey: string | null = null;
// Monotonic per-conversation sequence for image filenames so two submissions
// (or two messages) never write the same `img-<n>` path.
let nextImageSeq = 1;
let nextPasteSeq = 1;
// Test seam: spec files point the archive at an isolated temp dir.
let rootOverride: string | null = null;

export interface ArchiveManifestEntry {
	/** 1-based `[Image #N]` token number within the most recent submission. */
	token: number;
	/** Physical filename sequence (`img-<seq>.<ext>`). */
	seq: number;
	mediaType: string;
}

function attachmentsRoot(): string {
	return rootOverride ?? join(tmpdir(), 'nanocoder', ATTACHMENTS_DIR_NAME);
}

/** The physical directory for the current conversation (may not exist yet). */
export function getArchiveDirPath(): string {
	return join(attachmentsRoot(), getConversationKey());
}

/** Lazily mint the per-conversation key (regenerated on `/clear`). */
export function getConversationKey(): string {
	if (conversationKey === null) {
		conversationKey = randomUUID();
	}
	return conversationKey;
}

async function ensureArchiveDir(): Promise<string> {
	const dir = getArchiveDirPath();
	await mkdir(dir, {recursive: true});
	return dir;
}

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
};

function extensionForMediaType(mediaType: string): string {
	return MEDIA_TYPE_EXTENSIONS[mediaType] ?? 'img';
}

/**
 * Persist the images of one submitted message. Token numbers are the 1-based
 * positions in the array (the `[Image #N]` numbers the user/model see), so
 * `readImageAttachment(token)` resolves back to the exact file. The manifest
 * records only the most recent image-bearing submission — that is what a
 * mid-turn `examine_image` call refers to.
 */
export async function persistImages(
	images: ImageAttachment[],
): Promise<ArchiveManifestEntry[]> {
	if (images.length === 0) return [];
	const dir = await ensureArchiveDir();

	const entries: ArchiveManifestEntry[] = [];
	await Promise.all(
		images.map(async (image, i) => {
			const seq = nextImageSeq;
			nextImageSeq += 1;
			const ext = extensionForMediaType(image.mediaType);
			const filename = `img-${seq}.${ext}`;
			await writeFile(join(dir, filename), Buffer.from(image.data, 'base64'));
			entries[i] = {token: i + 1, seq, mediaType: image.mediaType};
		}),
	);

	// Stable token order regardless of Promise.all completion order.
	entries.sort((a, b) => a.token - b.token);
	await writeFile(
		join(dir, LATEST_MANIFEST_NAME),
		JSON.stringify(entries, null, 2),
	);
	return entries;
}

/** Persist pasted text as a plain-text copy (the transcript already has it). */
export async function persistPastes(
	placeholderContent: InputState['placeholderContent'],
): Promise<void> {
	const pastes = Object.values(placeholderContent).filter(
		(
			content,
		): content is Extract<typeof content, {type: PlaceholderType.PASTE}> =>
			content.type === PlaceholderType.PASTE,
	);
	if (pastes.length === 0) return;
	const dir = await ensureArchiveDir();

	await Promise.all(
		pastes.map(async paste => {
			const filename = `paste-${nextPasteSeq}.txt`;
			nextPasteSeq += 1;
			await writeFile(join(dir, filename), paste.content);
		}),
	);
}

/** Store the latest combined vision-fallback description for follow-up seeding. */
export async function persistDescription(description: string): Promise<void> {
	if (!description.trim()) return;
	const dir = await ensureArchiveDir();
	await writeFile(join(dir, DESCRIPTION_NAME), description);
}

/**
 * Read an archived image back into an `ImageAttachment` by its `[Image #N]`
 * token number. Returns the image plus its physical `seq` (used by callers to
 * key per-image state without cross-message bleed), or `null` when the
 * manifest has no such token (e.g. the image came from an earlier message or
 * a previous session).
 */
export async function readImageAttachment(
	token: number,
): Promise<{image: ImageAttachment; seq: number} | null> {
	if (!Number.isInteger(token) || token < 1) return null;
	if (conversationKey === null) return null;

	const dir = getArchiveDirPath();
	const manifest = await readManifest(dir);
	const entry = manifest?.find(e => e.token === token);
	if (!entry) return null;

	const ext = extensionForMediaType(entry.mediaType);
	const data = await readFile(join(dir, `img-${entry.seq}.${ext}`));
	return {
		image: {
			data: data.toString('base64'),
			mediaType: entry.mediaType,
			source: `img-${entry.seq}.${ext}`,
		},
		seq: entry.seq,
	};
}

async function readManifest(
	dir: string,
): Promise<ArchiveManifestEntry[] | null> {
	try {
		const raw = await readFile(join(dir, LATEST_MANIFEST_NAME), 'utf8');
		return JSON.parse(raw) as ArchiveManifestEntry[];
	} catch {
		// Missing/corrupt manifest — treat as "no re-examinable images".
		return null;
	}
}

/** Read the stored vision-fallback description, or null when none exists. */
export async function readStoredDescription(): Promise<string | null> {
	if (conversationKey === null) return null;
	try {
		return await readFile(join(getArchiveDirPath(), DESCRIPTION_NAME), 'utf8');
	} catch {
		return null;
	}
}

/**
 * Tear down the current conversation's archive and regenerate its key. Called
 * on `/clear` so a new conversation starts with an empty, fresh folder.
 */
export async function resetAttachmentArchive(): Promise<void> {
	if (conversationKey !== null) {
		await rm(getArchiveDirPath(), {recursive: true, force: true});
	}
	conversationKey = null;
	nextImageSeq = 1;
	nextPasteSeq = 1;
}

/** Test seam: redirect the archive root and reset all state. */
export async function setArchiveRootOverride(dir: string): Promise<void> {
	await resetAttachmentArchive();
	rootOverride = dir;
}

// Best-effort cleanup of the whole archive tree on exit. Specs that override
// the root never touch the real tmpdir archive, so this is safe under test.
getShutdownManager().register({
	name: 'attachment-archive-cleanup',
	priority: 30,
	handler: async () => {
		await rm(attachmentsRoot(), {recursive: true, force: true});
	},
});
