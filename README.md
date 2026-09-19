# claude-profiler

Profile a Claude Code session transcript: see where the time went, per tool and per turn.

A Claude Code session can run for hours and cost tens of dollars, and there's no built-in
way to find out where that time actually went. `claude-profiler` reads the transcript
`.jsonl` files Claude Code already writes to `~/.claude/projects/`, and turns one session
into a terminal UI: a Model / Tools+approvals / You time split, a measured breakdown of the
model's own time with a per-request drill-down, a sortable tool table, per-call drill-down,
subagent rollups, a timeline, and context growth over the session.

Install its hooks and it measures more than the transcript can express: how long *you*
spent approving, as distinct from the harness's own overhead; which tool results are
inflating your context window; time the session simply sat closed; and what resuming a
cold session cost to re-cache.

It answers one question — **where did the time go** — and nothing else. It presents
measurements, not advice.

## Usage

```sh
npx claude-profiler <query>
```

Once installed globally, the shorter `cprof` alias works the same way:

```sh
cprof <query>
```

`<query>` is either a session id — a full UUID, a unique prefix, or an `agent-*` subagent
transcript name — or a chat's title or first message. Anything made only of hex digits and
dashes is looked up as an id; anything else is searched for as text inside the transcripts.
`claude-profiler` searches every project directory under `~/.claude/projects/`.

When the query matches more than one session — the same id in two project directories, or
a title several chats share — you get an interactive picker listing each match's path,
title, last activity, size, turns and duration. Outside an interactive terminal there is
nothing to pick with, so it prints the matches and exits instead; rerun with a longer id.

```
Usage: claude-profiler <query> [options]

Profile a Claude Code session transcript and show where the time went.

Arguments:
  query            Session id (full uuid, unique prefix, or an agent-* name)
                   or a chat title to search for

Options:
  --json           Write the JSON profile artifact to a file instead of launching the TUI
  --out <path>     Write the JSON artifact to <path>
  --version        Print the version number and exit
  --help           Show this help message and exit
```

### Measurement hooks

```sh
claude-profiler install-hooks                   # exact timings on future sessions
claude-profiler install-hooks --stream-timing   # …plus time-to-first-token
claude-profiler uninstall-hooks
```

`install-hooks` shows you the exact `~/.claude/settings.json` diff and waits for
confirmation. It subscribes to 20 hook events — tool timing and permission prompts,
session start/end, subagent start/stop, compaction, model switches and instruction
loads — each appending one line to `~/.claude/profiler/<sessionId>.jsonl`.

The hook script is copied to `~/.claude/profiler/hooks/` and the hooks point at that copy,
not into the package, so they keep working after `npx` clears its cache or a global install
moves with your Node version. `uninstall-hooks` removes the copy.

Hooks only help sessions started *after* you install them; existing transcripts stay on
derived timings. Re-running `install-hooks` after an upgrade refreshes the copied script,
adds any newly subscribed events without duplicating the ones already there, and leaves
your original settings backup intact so `uninstall-hooks` still restores the file as it
was before the profiler ever touched it. Hooks from releases that pointed into the
package directly are moved over to the copy on that re-run.

**What it costs.** Each hook event spawns a short-lived Node process, measured at ~35ms
(p50, n=25) on an M-series Mac. `--stream-timing` adds `MessageDisplay`, which fires once
per batch of streamed output lines rather than once per turn, so its cost scales with how
much Claude writes. It buys the time-to-first-token split and nothing else; it is opt-in
for that reason.

**What the sidecar records.** Sizes and identifiers, never content. Prompt text, tool
inputs, tool results, compaction summaries and streamed message text are reduced to byte
counts before anything is written. Error and permission-denial reasons are the sole
exception, truncated to 200 characters, because "which failure" is the whole point of the
retry-tax view.

### Example: the Overview tab

Below is an example render of the Overview tab — the time split and the tool table it
opens on — not a captured screenshot, but the layout you'll actually see:

```
[1/4] Overview  Timeline  Context  Hooks

Model 42%  ████████████████░░░░░░░░░░░░░░░░░░░░░░  Tools+approvals 38%  You 12%  Unaccounted 8%

Tool          Calls   Total       Median    Outliers
Bash          61      12m 04s     6.2s      3
Edit          38      3m 51s      2.1s      0
Read          29      1m 40s      1.8s      0
Task          4       9m 12s      1m 58s    1

↑↓ select · ⏎ drill in · Esc back · ⇥ tabs · q quit
```

### Example: inside the Model bucket

`⏎` on the Model row opens its own breakdown: what the model produced, then where the
recorded time went.

```
measured · 183 requests

Output · 207.4k written
> Thinking      ████░░░░░░░░░░░░░░░░ 18.2% 37.7k tokens
  Generating    ████████████████░░░░ 81.8% 169.8k tokens

Context read back · 45.9M over the session, 250.6k per request
  Cache read    ███████████████████░ 96.2% 44.1M tokens
  Cache write   █░░░░░░░░░░░░░░░░░░░  3.8% 1.7M tokens
  Fresh input   ░░░░░░░░░░░░░░░░░░░░  0.0% 366 tokens
```

Every number comes straight from each request's `usage` — `thinking_tokens` is reported, not
inferred — so this is the same table for every session, with no fit, no sample floor and no
confidence caveat.

Output leads: it is the smaller number by two orders of magnitude and the one the screen is
for, while context is what that output cost to get. They get a bar each rather than sharing
one, because they are not the same quantity. Input counts the same context re-read on every request: 183 requests against 250.6k
of context is 45.9M "tokens" for a conversation holding a few hundred thousand. Output counts
what was written, once. Share a scale between them and output is 0.45% of the total with
thinking invisible inside it — which is the thing the screen exists to show. A context row a
session never had, like cache writes on a session that made none, is left out rather than
drawn at 0.0%.

Time is not in this table at all. Tokens cannot speak to the part of a session that was
spent waiting — a slept laptop produces none — and the headline bar already answers that,
with its own Stalled row and the `x` lens. A per-block time grid used to sit here too; on a
session that slept for eleven of its fourteen hours its leading row read 92.9%, a true
statement about timestamps and a useless one about the model, and it buried the split above.

A further `⏎` opens one row per API request, sortable by total time, first block, throughput
or context size — and `←→` from there shows the same total grouped by what handed control
back to the model, by model and by thinking effort:

```
  #   Started           Total    1st blk  Out    tok/s   Ctx     Cause
> 56  2026-08-16 17:38  4h38m    4h38m    1.1k   0.1     268.6k  after Artifact    ⚠ stalled
  70  2026-08-20 17:55  35m27s   40.3s    3.3k   1.5     302.5k  after Bash        ⚠ stalled
  54  2026-08-16 12:56  5m04s    36.3s    19.7k  64.8    248.3k  after Bash
  26  2026-08-16 12:07  2m14s    58.6s    5.7k   42.4    69.7k   after your prompt
```

## Keybindings

| Key | Action |
|---|---|
| `⇥` (Tab) | Cycle tabs: Overview → Timeline → Context → Hooks |
| `↑` `↓` | Move the selection in a list |
| `⏎` (Enter) | Drill into the selected row (a tool → its calls, a call → its detail, a `Task` row → the subagent rollup) |
| `Esc` / `⌫` (Backspace) | Go back one level |
| `s` | Cycle the sort order (the tool table on Overview, the request list under Model) |
| `←` `→` | Switch view inside a drilled-into screen (Model's requests/rollups, Bash's calls/by-command) |
| `/` | Filter (Overview) |
| `q` | Quit |

## What these numbers mean

**Tool durations include approval and idle wait — unless you have hooks installed.**
Claude Code's transcript has no field for "how long did the user take to approve this
tool call", only the tool's own start and end timestamps. A tool that shows as taking 18
minutes may be 20 fast calls and one call where you stepped away from the keyboard. Every
derived tool duration is therefore labelled **"tool + approvals"**, never "tool time",
and every sum is shown next to its median so a slow total doesn't hide one outlier.

**With hooks, approval and overhead are separated — and the separation matters.** CC's
`duration_ms` excludes permission-prompt and hook time, so the obvious derivation
(`wall − duration_ms`) looks like approval wait but also contains the profiler's own two
hook process spawns and CC's dispatch cost. Across every sidecar on this author's machine
— sessions running `defaultMode: auto`, where nothing could have been approved by hand —
that remainder has a hard floor near 30ms and a second cluster around 1.5s. Neither is a
person deciding anything.

`PreToolUse` fires before the permission prompt and `PermissionRequest` fires when the
prompt is raised, which splits the wait into three disjoint spans: dispatch overhead, your
decision, and execution. Sidecars written before this existed are marked `unsplit`, and
the Hooks tab says so rather than presenting their combined figure as approval time.

**"You" excludes time the session was closed.** The gap between a finished turn and your
next prompt is normally you writing that prompt. On a resumed session it isn't: CC appends
to the same transcript days later, so a four-day absence looks exactly like a pause at the
keyboard. Four transcripts over 1 MB on this author's machine profile at a ~6200-minute
span with 93–95% in "You"; in the largest, a single 5732-minute gap spanning a CC upgrade
accounts for 93% of the session.

`SessionStart` reports both the reason (`startup` / `resume` / `clear` / `compact` /
`fork`) and `seconds_since_last_response`, so that interval is measured rather than
guessed. With hooks, it becomes a separate **Idle** bucket; without them, it stays inside
"You" and the number is worth reading with that in mind. Idle is only ever carved out of
"You" and then "unaccounted" — never out of measured model or tool time.

**The model breakdown is measured, but a request's first block is a bundle.** Each row is
real wall-clock: Claude Code writes a record per content block, so the gap between two
records is the time that block took. The *first* record of a request is different — its
slice also covers queueing the call and reading the prompt back in, and the transcript
timestamps the block's end rather than its first token, so those three cannot be separated.
That is why the first block is its own row rather than folded into the rest. Exact
prefill/decode numbers do exist in Claude Code's OpenTelemetry `api_request` event
(`ttft_ms`, `duration_ms`), which the profiler does not yet consume — see
[`docs/otel-model-timing-findings.md`](docs/otel-model-timing-findings.md).

**"Stalled" is a stated heuristic, not a transcript fact.** A request that ran for over a
minute below a tenth of the session's own median throughput is flagged as probably waiting
rather than generating. Failed API calls are not a heuristic — Claude Code writes those
records itself and names the failure. Both are reported as a *subset* of the model time
above them, never subtracted twice, so the headline split still adds up.

**Cost appears only when the session has a `cost-state` record.** Claude Code started
writing that record in **2.1.260**; sessions from before that version, or sessions that
didn't exit cleanly, have no cost data — `claude-profiler` shows cost as absent rather
than estimating it. Cost is never computed from token counts or guessed.

**Where cost is shown, it is the API rate**, i.e. what the tokens would have cost when
billed by usage. If you're on a Claude subscription rather than API billing, this number
is *notional* — informative for comparing sessions, not a bill you'll actually receive.

**Cache-rewrite cost is the one exception, and it comes from CC itself.** Resuming a
session whose prompt cache has expired, or switching model mid-session, re-sends the whole
context window at cache-write rates. CC computes that estimate itself
(`estimated_cache_write_usd`) and hands it to the hook, so the Hooks tab can show it
without a price table and without estimating anything. It's still an estimate — the tab
names how CC priced it (`configured`, `catalog` or `default`).

**Context pollution is measured in bytes, not inferred.** With hooks, every tool result's
serialized size is recorded. A single `Bash` call returning 40 KB isn't a one-off cost: it
sits in the cached prefix and is re-billed as cache read on every later turn. The Hooks tab
ranks tools by total result bytes for that reason.

## The JSON artifact

Every run writes a JSON profile artifact — to `~/.claude/profiler/profiles/<sessionId>.json`
by default, or to the path you pass with `--out` — before the TUI launches. Pass `--json`
to write it and skip the TUI; stdout then carries only the path it was written to, not the
JSON itself:

```sh
cprof 7801be40 --json --out profile.json && jq '.timeline' profile.json
```

The same happens without `--json` when stdin is not an interactive terminal: the artifact is
written, and the TUI is not started.

**`timeline.modelMs` includes stalled time.** The artifact keeps the headline split as
measured, so a session whose machine slept mid-request can report days of model time. The
stalled and failed-call part is `modelBreakdown.suspectMs`; subtract it for the time the
model actually worked, which is what the TUI's Model row shows next to its Stalled row.

The artifact is complete enough that the whole TUI could be rebuilt from it alone, without
the original transcript. Two top-level fields are populated only when a hook sidecar
exists and are `null` otherwise: `hooks` (the measurements above) and `phases` (the time
split with idle carved out). Its shape is versioned via a top-level `schemaVersion` field,
currently `"0.2"`. **The schema is unstable until 1.0** — field names, shapes, and
semantics may change between minor versions without notice. Don't build long-term
tooling against `0.x` without pinning the exact `claude-profiler` version you tested
against.

## Privacy

Transcripts contain your source code and prompts. `claude-profiler` reads only local
files under `~/.claude/projects/`, makes no network calls, and writes its output only to
your own machine. Nothing leaves it.

The hook sidecar is held to a stricter rule than the profiler's own reads: it records
sizes and identifiers, never content. The transcript is already your own record of the
session, and a profiler has no business making a second copy of it. See **Measurement
hooks** above for the one narrow exception.

## Development

```sh
pnpm install
pnpm verify   # build + unit tests
```

`test/corpus.test.ts` is a smoke test over your own real transcripts under
`~/.claude/projects/`; it skips cleanly (not a failure) when that directory doesn't exist,
which is the case in CI.

## License

MIT — see [LICENSE](LICENSE).
