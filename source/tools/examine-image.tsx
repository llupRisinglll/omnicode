import {Box, Text} from 'ink';
import React from 'react';
import {ToolCallHeader} from '@/components/simple-tool-formatter';
import {getAppConfig} from '@/config/index';
import {getVisionModel, getVisionModelProvider} from '@/config/preferences';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {createVisionClient} from '@/models/vision';
import type {LLMClient, Message, NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';
import {
	getConversationKey,
	readImageAttachment,
	readStoredDescription,
} from '@/utils/attachment-archive';
import {calculateTokens} from '@/utils/token-calculator';

/** Build the vision client used for a re-examination call. */
type VisionClientFactory = (
	model: string,
	provider?: string,
) => Promise<LLMClient>;

let visionClientFactory: VisionClientFactory = (model, provider) =>
	createVisionClient(model, provider);

/** Test seam: swap the vision client factory for a fake. */
export function setVisionClientFactoryForTests(
	factory: VisionClientFactory,
): void {
	visionClientFactory = factory;
}

/**
 * Re-examination of an attached image through the vision fallback model.
 *
 * When the `[Image Analysis]` block handed to a text-only main model isn't
 * detailed enough, this tool re-sends the original image to the vision model
 * and resumes that model's conversation so it can answer a targeted follow-up
 * (e.g. "read the error dialog text verbatim") instead of re-describing from
 * scratch. The conversation state lives here, keyed by conversation + physical
 * image seq, so successive questions accumulate context.
 */
const visionConversations = new Map<string, Message[]>();

/** Tear down all follow-up conversations (called on `/clear`). */
export function clearVisionFollowupState(): void {
	visionConversations.clear();
}

const MAX_QUESTION_LENGTH = 2000;

function defaultQuestion(index: number): string {
	return `Describe image #${index} in more detail than your earlier analysis — be exhaustive about anything the assistant might need.`;
}

function seedPrompt(description: string | null): string {
	if (description) {
		return (
			'You previously analyzed this image for a text-only model. Here is your prior analysis:\n\n' +
			`${description}\n\n` +
			'The assistant needs more detail. Answer its follow-up question using the image and your prior analysis.'
		);
	}
	return (
		'You are a meticulous image analyst. The assistant needs to examine this image more closely. ' +
		'Answer its follow-up question precisely, citing visible evidence (text, layout, colors, UI state).'
	);
}

export const executeExamineImage = async (
	args: {index: number; question?: string},
	options?: {abortSignal?: AbortSignal},
): Promise<string> => {
	const {index, question} = args;

	if (!Number.isInteger(index) || index < 1) {
		return `examine_image: index must be a positive integer matching the [Image #N] token (got ${JSON.stringify(index)}).`;
	}

	const archived = await readImageAttachment(index);
	if (!archived) {
		return (
			`examine_image: image #${index} is not available for re-examination. ` +
			'Only images attached in the current conversation (with a [Image #N] token in the most recent user message) can be examined.'
		);
	}

	const visionModel = getVisionModel();
	if (!visionModel) {
		return (
			`examine_image: no vision model is configured, so image #${index} cannot be re-examined. ` +
			'Tell the user to set one in Settings → Capabilities → Vision Model, then retry.'
		);
	}

	const description = await readStoredDescription();
	const stateKey = `${getConversationKey()}:${archived.seq}`;
	let convo = visionConversations.get(stateKey);
	if (!convo) {
		convo = [
			{
				role: 'user',
				content: seedPrompt(description),
				images: [archived.image],
			},
		];
		visionConversations.set(stateKey, convo);
	}
	convo.push({
		role: 'user',
		content: question?.trim() || defaultQuestion(index),
	});

	try {
		const storedVisionProvider = getVisionModelProvider();
		const visionProvider =
			storedVisionProvider ||
			getAppConfig().providers?.find(p =>
				(p.models ?? []).includes(visionModel),
			)?.name;
		const visionClient = await visionClientFactory(
			visionModel,
			visionProvider || undefined,
		);

		let output = '';
		await visionClient.chat(
			convo,
			{},
			{
				onToken: token => {
					output += token;
				},
			},
			options?.abortSignal,
		);

		const answer = output.trim();
		convo.push({role: 'assistant', content: answer});
		return `Vision re-examination of image #${index} (${visionModel}):\n${answer}`;
	} catch (error) {
		return `examine_image: vision model ${visionModel} failed to re-examine image #${index}: ${String(error)}`;
	}
};

const examineImageCoreTool = tool({
	description:
		"Re-examine an image that was attached to this conversation by asking the configured vision model a targeted follow-up question. Use it when the [Image Analysis] block (or your own reading) lacks detail you need — for example reading text verbatim, focusing on a specific region, or resolving something summarized too loosely. The vision model sees its prior analysis plus the original image, so it answers the new question without re-describing from scratch. Returns the vision model's answer.",
	inputSchema: jsonSchema<{index: number; question?: string}>({
		type: 'object',
		properties: {
			index: {
				type: 'integer',
				description:
					'The 1-based image number from the [Image #N] token in the most recent user message (e.g. 2 for [Image #2]).',
			},
			question: {
				type: 'string',
				description:
					'The targeted question to ask the vision model (e.g. "Read the error dialog text verbatim"). Defaults to a generic "more detail" request when omitted.',
			},
		},
		required: ['index'],
	}),
	execute: (args, options) => executeExamineImage(args, options),
});

function ExamineImageFormatterComponent({
	index,
	question,
	result,
}: {
	index: number;
	question?: string;
	result?: string;
}): React.ReactElement {
	const boxWidth = useTerminalWidth();
	const {colors} = useTheme();

	const resultTokens = result ? calculateTokens(result) : 0;

	return (
		<Box flexDirection="column" marginBottom={1} width={boxWidth}>
			<ToolCallHeader toolName="examine_image" detail={`image #${index}`} />
			{question && (
				<Box>
					<Text color={colors.secondary}>Question: </Text>
					<Box marginLeft={1} flexShrink={1}>
						<Text wrap="truncate-end" color={colors.text}>
							{question}
						</Text>
					</Box>
				</Box>
			)}
			{result && (
				<Box>
					<Text color={colors.secondary}>Answer: </Text>
					<Text color={colors.text}>~{resultTokens} tokens</Text>
				</Box>
			)}
		</Box>
	);
}

export const examineImageFormatter = (
	args: {index: number; question?: string},
	result?: string,
): React.ReactElement => {
	return (
		<ExamineImageFormatterComponent
			index={args.index}
			question={args.question}
			result={result}
		/>
	);
};

export const examineImageValidator = (args: {
	index: number;
	question?: string;
}): Promise<{valid: true} | {valid: false; error: string}> => {
	if (!Number.isInteger(args.index) || args.index < 1) {
		return Promise.resolve({
			valid: false,
			error: 'index must be a positive integer',
		});
	}
	if (args.question && args.question.length > MAX_QUESTION_LENGTH) {
		return Promise.resolve({
			valid: false,
			error: `question is too long (${args.question.length} characters). Maximum length is ${MAX_QUESTION_LENGTH} characters.`,
		});
	}
	return Promise.resolve({valid: true});
};

export const examineImageTool: NanocoderToolExport = {
	name: 'examine_image' as const,
	tool: examineImageCoreTool,
	formatter: examineImageFormatter,
	validator: examineImageValidator,
	readOnly: true,
};
