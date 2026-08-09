import type {ImageAttachment, Message, ToolResult} from '@/types/core';
import {
	defaultPrScope,
	type PrCaptureSource,
	recordPrUrls,
	shouldCapturePrUrl,
} from '@/utils/pr-store';

/**
 * Builder pattern for constructing message arrays.
 * Provides a fluent interface for adding messages without side effects.
 * This ensures messages are only added to state once, preventing duplication.
 * The one exception: PR links in committed content are persisted to the
 * out-of-band PR store (see pr-store.ts) so `/tool:open-prs` can reopen them
 * later without keeping them in the model context.
 */
export class MessageBuilder {
	private messages: Message[];

	constructor(initialMessages: Message[]) {
		this.messages = [...initialMessages];
	}

	/**
	 * Persist PR links found in committed content. Lazy: only touches disk
	 * when a PR URL is actually present (rare), so normal message adds pay no
	 * I/O cost.
	 */
	private capturePrLinks(...sources: PrCaptureSource[]): void {
		if (
			!sources.some(
				source =>
					source.content.includes('/pull/') ||
					source.content.includes('/merge_requests/'),
			)
		) {
			return;
		}
		const toScan = sources.filter(shouldCapturePrUrl);
		if (toScan.length === 0) return;
		recordPrUrls(defaultPrScope(), ...toScan.map(source => source.content));
	}

	/**
	 * Add an assistant message (with or without tool_calls).
	 */
	addAssistantMessage(msg: Message): this {
		if (msg.role !== 'assistant') {
			throw new Error(
				'addAssistantMessage requires a message with role "assistant"',
			);
		}
		this.capturePrLinks(
			{role: msg.role, name: msg.name, content: msg.content},
			{role: msg.role, name: msg.name, content: msg.reasoning ?? ''},
		);
		this.messages.push(msg);
		return this;
	}

	/**
	 * Add tool result messages from tool execution.
	 */
	addToolResults(results: ToolResult[]): this {
		const toolMessages: Message[] = results.map(result => ({
			role: 'tool' as const,
			content: result.content || '',
			tool_call_id: result.tool_call_id,
			name: result.name,
			structuredContent: result.structuredContent,
		}));
		this.capturePrLinks(
			...results.map(result => ({
				role: result.role,
				name: result.name,
				content: result.content,
			})),
		);
		this.messages.push(...toolMessages);
		return this;
	}

	/**
	 * Add a user message, optionally with image attachments for multimodal turns.
	 */
	addUserMessage(content: string, images?: ImageAttachment[]): this {
		this.capturePrLinks({role: 'user', content});
		this.messages.push({
			role: 'user',
			content,
			...(images && images.length > 0 ? {images} : {}),
		});
		return this;
	}

	/**
	 * Add an error message as a user message (for model self-correction).
	 */
	addErrorMessage(errorContent: string): this {
		this.capturePrLinks({role: 'user', content: errorContent});
		this.messages.push({
			role: 'user',
			content: errorContent,
		});
		return this;
	}

	/**
	 * Add an arbitrary message (use sparingly, prefer specific methods).
	 */
	addMessage(message: Message): this {
		this.capturePrLinks({
			role: message.role,
			name: message.name,
			content: message.content,
		});
		this.messages.push(message);
		return this;
	}

	/**
	 * Build and return the final messages array.
	 */
	build(): Message[] {
		return this.messages;
	}

	/**
	 * Get the current length of the messages array.
	 */
	get length(): number {
		return this.messages.length;
	}

	/**
	 * Check if the builder has any messages.
	 */
	get isEmpty(): boolean {
		return this.messages.length === 0;
	}
}
