---
"@nanocollective/nanocoder": patch
---

A mid-stream stall — a slow or free model going quiet past the provider's SSE inactivity window — no longer drops the turn back to the prompt. The request is retried automatically (up to twice) before the error surfaces, so a single transient hiccup no longer loses the turn.
