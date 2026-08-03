import {createLLMClient} from '@/client-factory';
import type {ImageAttachment, LLMClient, Message} from '@/types/core';

/**
 * Build an LLM client for the vision fallback model.
 *
 * Standalone module (not re-exported through `@/models/index`) because it
 * depends on `@/client-factory`, which transitively imports `@/models/index`
 * — routing these through the index would create an import cycle.
 */
export async function createVisionClient(
	model: string,
	provider?: string,
): Promise<LLMClient> {
	const {client} = await createLLMClient(provider, model);
	return client;
}

/**
 * Ask the vision model to describe the attached images so a text-only main
 * model can understand them. `userMessage` is the user's original prompt
 * (e.g. "I attached a screenshot of the page that has an issue") so the vision
 * model knows what to focus on — including any arrows/boxes/labels the user
 * drew on the screenshot to point at specific parts. Returns the model's full
 * text output (trimmed).
 */
export async function processImagesWithVisionModel(
	visionClient: LLMClient,
	images: ImageAttachment[],
	mainModel: string,
	userMessage?: string,
	onStatus?: (status: string) => void,
	signal?: AbortSignal,
): Promise<string> {
	const contextBlock = userMessage?.trim()
		? `The user attached this image to support the following message:\n\n"${userMessage.trim()}"\n\n`
		: '';

	const prompt =
		'You are a meticulous image analyst. ' +
		contextBlock +
		'Describe the image(s) exhaustively so a text-only AI model can fully ' +
		'understand them without ever seeing them. ' +
		'The user may have drawn annotations on the screenshot (arrows, boxes, ' +
		'circles, highlights, numbers, or text labels) to point at specific parts ' +
		'— if any are present, say exactly what each one marks and where it ' +
		'points. Capture:\n' +
		'- All visible text verbatim (field labels, buttons, error messages, URLs).\n' +
		'- Layout, colors, spacing, and visual hierarchy.\n' +
		'- UI state (focused fields, open dropdowns/modals, toggles, error states).\n' +
		'- Anything that looks like a bug, mismatch, or anomaly.\n' +
		'Write a structured report. Be exhaustive — the reader cannot see the image at all.';

	const messages: Message[] = [
		{
			role: 'user',
			content: prompt,
			images,
		},
	];

	let output = '';
	onStatus?.(`Sending to ${visionClient.getCurrentModel()}…`);
	await visionClient.chat(
		messages,
		{},
		{
			onToken: token => {
				output += token;
			},
		},
		signal,
	);

	onStatus?.(`Description received (${output.trim().length} chars)`);
	return output.trim();
}
