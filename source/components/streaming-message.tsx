import {memo} from 'react';

import AssistantMessage from './assistant-message';

/**
 * Live-region renderer for an in-flight assistant message.
 *
 * The growing message renders FORMATTED through the real AssistantMessage
 * pipeline (headings, lists, code and tables appear as they arrive) so the
 * streaming response looks exactly like the settled transcript — never a
 * plain-text tail window with truncation dots. Completion flushes the same
 * shape, so the live region swaps to the static message without a visual
 * jump or a formatting change.
 */
export default memo(function StreamingMessage({
	message,
	model,
}: {
	message: string;
	model: string;
}) {
	return <AssistantMessage message={message} model={model} />;
});
