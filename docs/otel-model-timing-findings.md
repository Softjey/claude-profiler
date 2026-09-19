# OTEL model-timing findings

## Question

The Model bucket is derived: every number in `model-breakdown.ts` comes from the gaps
between transcript record timestamps, which are write times, not API times. Record
timestamps mark when a content block *finished* streaming, so the leading slice of every
request bundles three things that cannot be separated — queueing, reading the prompt back in
(prefill), and generating the first block. That bundle is 46–67% of model time on every
session measured.

Does Claude Code emit anything that separates them, the way the `PreToolUse`/`PostToolUse`
hooks separated approval wait from tool execution (T9)?

## Setup

```sh
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
OTEL_METRICS_EXPORTER=console OTEL_LOGS_EXPORTER=console \
OTEL_METRIC_EXPORT_INTERVAL=1000 OTEL_LOGS_EXPORT_INTERVAL=1000 \
claude -p "reply with the single word: ok" --model haiku
```

CC 2.1.274, non-interactive, one prompt. Console exporter so nothing had to be stood up.

## Answer: yes, and with the join key needed to use it

CC emits a `claude_code.api_request` OTEL **log event** per API call. Captured verbatim:

```
body: "claude_code.api_request",
attributes: {
  "session.id": "00000000-0000-0000-0000-000000000001",
  "prompt.id":  "00000000-0000-0000-0000-000000000002",
  model: "claude-haiku-4-5-20251001",
  input_tokens: 10,
  output_tokens: 43,
  cache_read_tokens: 0,
  cache_creation_tokens: 34427,
  cost_usd: 0.069079,
  duration_ms: 1184,
  ttft_ms: 791,
  request_id: "req_011Cf9PNZNi8r1eLfmCDAxQA",
  client_request_id: "00000000-0000-0000-0000-000000000003",
  speed: "normal",
  query_source: "sdk",
}
```

Three things matter here:

1. **`ttft_ms` and `duration_ms` are exact API timings.** `ttft_ms` is the prefill+queue
   number the transcript cannot produce; `duration_ms - ttft_ms` is decode. This is the
   "derived → exact" upgrade for the Model bucket that the hook sidecar was for tools.
2. **`request_id` is the same `req_…` id the transcript writes** on every assistant record.
   It is the join key, exactly as `tool_use_id` was in T9 — correlation by id, never by
   proximity in time.
3. **`session.id` scopes it**, so a sidecar can be keyed per session like the hook one.

Also emitted per call: `claude_code.assistant_response`, `claude_code.token.usage`,
`claude_code.cost.usage`, and `claude_code.user_prompt` / `claude_code.active_time.total`
per session. `query_source` distinguishes real work (`sdk`) from CC's own housekeeping
calls (`generate_session_title`) — housekeeping requests never reach the transcript, so the
merge must expect OTEL events with no matching record and drop them rather than invent a
request.

## What is not there

- **No retry or attempt attribute.** The binary carries `retryCount`, `attemptNumber` and
  `durationMsIncludingRetries` internally, but none of them appear on the exported event.
  Retry overhead stays underived. `error_code` appears on failure events only.
- **No trace/span ids on these events** (`traceId: undefined`), so they are logs, not spans.
- **No file exporter.** The only `OTEL_*_EXPORTER` values CC accepts are `console`, `otlp`
  and `prometheus`. `console` writes to the same stdout the TUI uses, so it is unusable in
  practice; there is no `OTEL_..._FILE` variable despite an internal "OTEL raw body file
  write failed" message.

## What this means for the profiler

The exact merge is possible but needs a receiver, which is a bigger shape of work than the
hook sidecar: a `claude-profiler` OTLP endpoint on localhost, an install step that writes
`CLAUDE_CODE_ENABLE_TELEMETRY` / `OTEL_LOGS_EXPORTER=otlp` /
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` into settings, and a merge that joins `api_request`
events to `ModelRequest` rows on `request_id`.

Once joined, each request gains:

| Field | From | Replaces |
|---|---|---|
| `ttft_ms` | OTEL | the unsplittable "first block" position |
| `duration_ms` | OTEL | `totalMs` derived from record gaps |
| `duration_ms - ttft_ms` | derived from OTEL | true decode time, and a true tok/s |

The `stalled` heuristic disappears entirely for covered requests: a machine that slept
between two records shows a short `duration_ms` against a long record gap, which is a
measurement, not a guess.

Same partial-coverage rule as the hook sidecar: a request with no matching OTEL event keeps
its derived numbers and `precision` stays `"measured"`, never silently upgraded.
