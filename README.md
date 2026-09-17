# claude-profiler

Profile a Claude Code session transcript: see where the time went, per tool and per turn.

A Claude Code session can run for hours and cost tens of dollars, and there's no built-in
way to find out where that time actually went. `claude-profiler` reads the transcript
`.jsonl` files Claude Code already writes to `~/.claude/projects/`, and turns one session
into a terminal UI: a Model / Tools+approvals / You time split, a measured breakdown of the
model's own time with a per-request drill-down, a sortable tool table, per-call drill-down,
subagent rollups, a timeline, and context growth over the session.

It answers one question — **where did the time go** — and nothing else. It presents
measurements, not advice.

## Usage

```sh
npx claude-profiler <sessionId>
```

Once installed globally, the shorter `cprof` alias works the same way:

```sh
cprof <sessionId>
```

`<sessionId>` can be a full UUID, a unique prefix, or an `agent-*` subagent transcript
name. `claude-profiler` searches every project directory under `~/.claude/projects/` for
a match; if the same id shows up in more than one project, you get an interactive picker.

```
Usage: claude-profiler <sessionId> [options]

Profile a Claude Code session transcript and show where the time went.

Arguments:
  sessionId        Session id: full uuid, unique prefix, or an agent-* name

Options:
  --json           Print the JSON profile artifact to stdout instead of launching the TUI
  --out <path>     Write the JSON artifact to <path>
  --version        Print the version number and exit
  --help           Show this help message and exit
```

### Example: the Overview tab

Below is an example render of the Overview tab — the time split and the tool table it
opens on — not a captured screenshot, but the layout you'll actually see:

```
[1/3] Overview  Timeline  Context

Model 42%  ████████████████░░░░░░░░░░░░░░░░░░░░░░  Tools+approvals 38%  You 12%  Unaccounted 8%

Tool          Calls   Total       Median    Outliers
Bash          61      12m 04s     6.2s      3
Edit          38      3m 51s      2.1s      0
Read          29      1m 40s      1.8s      0
Task          4       9m 12s      1m 58s    1

↑↓ select · ⏎ drill in · Esc back · ⇥ tabs · q quit
```

### Example: inside the Model bucket

`⏎` on the Model row opens its own breakdown. Claude Code writes one transcript record per
content block, each with its own timestamp, so this is measured wall-clock per kind of
output — not `modelMs` split by token share:

```
measured from per-block record timestamps · 83 requests, 68 written as more than one block
> Writing text (1st block)        ██████████████░░░░░░ 71.7% (4h50m, 3 slices)
  Writing text (later)            ████░░░░░░░░░░░░░░░░ 18.3% (1h14m, 47 slices)
  Thinking (1st block)            █░░░░░░░░░░░░░░░░░░░ 6.4% (25m56s, 69 slices)
  Emitting tool calls (later)     █░░░░░░░░░░░░░░░░░░░ 3.4% (13m36s, 73 slices)
  Emitting tool calls (1st block) ░░░░░░░░░░░░░░░░░░░░ 0.3% (1m06s, 11 slices)

5h50m (86.4%) of this is probably not the model working:
  3 requests that ran for minutes below 5.3 tok/s — a slept machine or a dropped stream — 5h38m
  1 failed API call CC wrote itself (server_error) — 11m51s
  counted in the rows above, not on top of them: 54m58s is left that looks like generation
```

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
| `⇥` (Tab) | Cycle tabs: Overview → Timeline → Context |
| `↑` `↓` | Move the selection in a list |
| `⏎` (Enter) | Drill into the selected row (a tool → its calls, a call → its detail, a `Task` row → the subagent rollup) |
| `Esc` / `⌫` (Backspace) | Go back one level |
| `s` | Cycle the sort order (the tool table on Overview, the request list under Model) |
| `←` `→` | Switch view inside a drilled-into screen (Model's requests/rollups, Bash's calls/by-command) |
| `/` | Filter (Overview) |
| `q` | Quit |

## What these numbers mean

**Tool durations include approval and idle wait.** Claude Code's transcript has no field
for "how long did the user take to approve this tool call" — only the tool's own start
and end timestamps. A tool that shows as taking 18 minutes may be 20 fast calls and one
call where you stepped away from the keyboard. Every tool duration in this tool is
therefore labelled **"tool + approvals"**, never "tool time", and every sum is shown next
to its median and its outlier count so a slow total doesn't hide one outlier.

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

## The JSON artifact

Every run writes a JSON profile artifact (to a default location under `~/.claude/profiler/`,
or to the path you pass with `--out`) before the TUI launches. Pass `--json` to print it to
stdout instead of opening the TUI — useful for scripting or piping into `jq`.

The artifact is complete enough that the whole TUI could be rebuilt from it alone, without
the original transcript. Its shape is versioned via a top-level `schemaVersion` field,
currently `"0.1"`. **The schema is unstable until 1.0** — field names, shapes, and
semantics may change between minor versions without notice. Don't build long-term
tooling against `0.x` without pinning the exact `claude-profiler` version you tested
against.

## Privacy

Transcripts contain your source code and prompts. `claude-profiler` reads only local
files under `~/.claude/projects/`, makes no network calls, and writes its output only to
your own machine. Nothing leaves it.

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
