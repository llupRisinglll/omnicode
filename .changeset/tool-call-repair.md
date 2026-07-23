---
"@nanocollective/nanocoder": patch
---

Interrupting a turn after the model started a tool call but before its result no longer wedges the conversation. Any tool call left unanswered is closed with a cancellation result before the next request, so a new message resumes normally instead of failing forever with "tool_calls must be followed by tool results".
