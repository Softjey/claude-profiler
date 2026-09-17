# claude-profiler

Profile a Claude Code session transcript: see where the time went, per tool and per turn.

A Claude Code session can run for hours and cost tens of dollars, and there's no built-in
way to find out where that time actually went. `claude-profiler` reads the transcript
`.jsonl` files Claude Code already writes to `~/.claude/projects/`, and turns one session
into a terminal UI: a Model / Tools+approvals / You time split, a sortable tool table,
per-call drill-down, subagent rollups, a timeline, and context growth over the session.

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

## Keybindings

| Key | Action |
|---|---|
| `⇥` (Tab) | Cycle tabs: Overview → Timeline → Context |
| `↑` `↓` | Move the selection in a list |
| `⏎` (Enter) | Drill into the selected row (a tool → its calls, a call → its detail, a `Task` row → the subagent rollup) |
| `Esc` / `⌫` (Backspace) | Go back one level |
| `s` | Cycle the tool table's sort order (Overview) |
| `/` | Filter (Overview) |
| `q` | Quit |

## What these numbers mean

**Tool durations include approval and idle wait.** Claude Code's transcript has no field
for "how long did the user take to approve this tool call" — only the tool's own start
and end timestamps. A tool that shows as taking 18 minutes may be 20 fast calls and one
call where you stepped away from the keyboard. Every tool duration in this tool is
therefore labelled **"tool + approvals"**, never "tool time", and every sum is shown next
to its median and its outlier count so a slow total doesn't hide one outlier.

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
