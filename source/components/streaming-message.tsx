import {memo, useEffect, useRef, useState} from 'react';

import AssistantMessage from './assistant-message';

/**
 * Live-region parse cadence while a reply is streaming. The parent flushes
 * tokens ~every 250ms, but re-parsing the WHOLE growing markdown message on
 * every flush is O(message) per flush — the main-thread cost that makes
 * typing stall while a long reply renders. Throttle the expensive parse to a
 * trailing cadence and always flush the final chunk, so the animation stays
 * smooth but the event loop keeps room for keystrokes.
 */
const STREAMING_RENDER_INTERVAL_MS = 350;

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
	// Hold the last fully-parsed snapshot in state; new message props are
	// applied on a fixed cadence. This bounds markdown re-parse frequency
	// independently of the token flush rate (a fast stream no longer re-parses
	// the whole message 4x/sec) while still showing the LATEST content each
	// tick — the timer runs continuously during a stream instead of being
	// reset by every flush (which would never fire).
	const [displayed, setDisplayed] = useState(message);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestRef = useRef(message);

	useEffect(() => {
		latestRef.current = message;
		// If the latest content is already on screen, stop throttling. If a
		// timer is pending, keep it — it will apply the newest snapshot when it
		// fires. Otherwise start a fresh cadence tick.
		if (message === displayed) return;
		if (timerRef.current) return;
		const tick = () => {
			timerRef.current = null;
			// Apply whatever is newest NOW; if more arrived since the tick was
			// scheduled, the effect re-runs and starts the next tick.
			setDisplayed(latestRef.current);
		};
		timerRef.current = setTimeout(tick, STREAMING_RENDER_INTERVAL_MS);
	}, [message, displayed]);

	// Clear the timer only on unmount — not on prop changes, or a continuous
	// stream would keep resetting it and never render.
	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		},
		[],
	);

	return <AssistantMessage message={displayed} model={model} />;
});
