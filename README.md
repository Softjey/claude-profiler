# claude-profiler

[![npm](https://img.shields.io/npm/v/claude-profiler)](https://www.npmjs.com/package/claude-profiler)
[![CI](https://github.com/Softjey/claude-profiler/actions/workflows/ci.yml/badge.svg)](https://github.com/Softjey/claude-profiler/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/claude-profiler)](package.json)
[![license](https://img.shields.io/npm/l/claude-profiler)](LICENSE)

See where the time went in a Claude Code session: how much was the model, how much was
tools, how much was you. It reads the transcripts Claude Code already saves in
`~/.claude/projects/` and shows one session in a terminal UI.

```sh
npx claude-profiler "fix flaky login test"
```

## Install

With Node.js 22+, run it through `npx` as above, or install it globally:

```sh
npm install -g claude-profiler
```

Without Node, or with an older one, use the standalone build. It is one executable that
carries its own Node, for macOS, Linux and Windows on arm64 and x64.

macOS and Linux:

```sh
brew install softjey/tap/claude-profiler
# or
curl -fsSL https://raw.githubusercontent.com/Softjey/claude-profiler/master/install.sh | sh
```

Windows (PowerShell):

```powershell
scoop bucket add softjey https://github.com/Softjey/scoop-bucket
scoop install claude-profiler
# or
irm https://raw.githubusercontent.com/Softjey/claude-profiler/master/install.ps1 | iex
```

The install scripts put it in `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows, which
`install.ps1` adds to your PATH), verify its checksum, and upgrade in place when run again.
Set `CPROF_INSTALL_DIR` to install elsewhere, or `CPROF_VERSION` to pin a release. You can
also download an archive from the [releases](https://github.com/Softjey/claude-profiler/releases)
page yourself. Every method installs it as both `claude-profiler` and `cprof`.

Windows may warn about an unrecognized app the first time you run it, because the
executable is not code-signed.

## What it looks like

Captured from a real 30-minute session (session id and project path replaced):

```text
Session  1c128c06-…
Project  ~/code/my-app
Started  2026-09-19 21:07
Span     29m45s
Cost     —
Models   claude-opus-5
Turns    12

[1/4] Overview  Timeline  Context  Hooks

  Model      ███████░░░░░░░░░░░░░░░░░░░░░░░ 24.7% (7m20s)
> Tools      ██████████░░░░░░░░░░░░░░░░░░░░ 32.4% (9m39s)
  You        █████████████░░░░░░░░░░░░░░░░░ 42.8% (12m44s)
  Unaccounted░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0.1% (1.6s)

sorted by total · 5 tools
Tool                               Total     %       Calls  Median
> Bash                             9m30s     31.9%   59     3.1s
  WebFetch                         6.4s      0.4%    1      6.4s
  Edit                             2.3s      0.1%    2      1.2s
  Write                            1.4s      0.1%    1      1.4s
  ToolSearch                       103ms     0.0%    1      103ms

↑↓ select · ⏎ drill in · Esc back · ←→ tabs · s sort · / filter · q quit
```

- **Model**: time Claude spent producing responses.
- **Tools**: time from a tool call to its result. Without hooks, this includes any time
  you took to approve the call.
- **You**: time between Claude finishing and your next message.
- **Unaccounted**: gaps that fit none of the above.

## Usage

```sh
claude-profiler <query>            # or `cprof <query>` after a global install
claude-profiler <query> --json     # write the JSON profile, skip the UI
claude-profiler install-hooks      # measure future sessions more precisely
```

`<query>` is either:

- a **session id**: a full UUID, a unique prefix like `3f2a9c1e`, or an `agent-*` subagent
  transcript name. Anything made only of hex digits and dashes is treated as an id.
- **text** from a chat's title or first message, matched across all projects.

If several sessions match, you get a picker. Outside an interactive terminal, the matches are
printed instead so you can rerun with a more specific query.

| Option | |
| --- | --- |
| `--json` | Write the JSON profile and exit without opening the UI |
| `--out <path>` | Where to write the JSON profile |
| `--version`, `--help` | |

## Screens

Four tabs; `←` `→` switches between them.

- **Overview** shows the time split. Select **Model** to see thinking vs. output tokens
  and how much context was read from cache. Select **Tools** for the table above. Select
  **You** for the list of pauses before each of your prompts.
- **Timeline** lists every turn with its span, tool count, tool time and the prompt that
  started it.
- **Context** shows sparklines of context size, output tokens and thinking tokens over the
  session.
- **Hooks** shows data that only hooks can record: approval time, failed calls, result
  sizes per tool, and cache-rewrite cost. Without hooks, this tab says so.

Drilling in from Overview:

- **Tools → a tool → a call**: individual calls sorted by duration, then one call's
  details. `←` `→` on **Bash** switches to a view grouped by command. An **Agent** or
  **Task** call opens its subagent's own breakdown.
- **Model → requests**: one row per API request.

  ```text
    #   Started           Total    1st blk  Out    tok/s   Ctx     Cause
  > 23  2026-09-19 21:14  27.4s    3.3s     4.0k   146.0   73.6k   after Bash
    21  2026-09-19 21:14  22.7s    4.9s     3.1k   138.1   68.5k   after Bash
    19  2026-09-19 21:14  20.3s    19.2s    2.1k   101.2   60.5k   after Bash
  ```

  Use `←` `→` to switch to the same time grouped by cause, model and thinking effort.

### Keys

| Key | Action |
| --- | --- |
| `←` `→` | Switch tabs. On a drilled-in screen, switch that screen's view |
| `↑` `↓` | Move the selection |
| `⏎` | Go deeper: into a category's table, then into the selected row |
| `Esc` | Go back one level |
| `s` | Change sort order (tool table, request list) |
| `/` | Filter the tool table by name |
| `x` | Hide or show stalled time (shown only when the session has any) |
| `q` | Quit |

## Hooks (optional)

The transcript records when a tool call started and ended, but not when you approved it
or how long the session sat closed. Hooks record those details for sessions started
after you install them.

```sh
claude-profiler install-hooks                   # 18 hook events
claude-profiler install-hooks --stream-timing   # + MessageDisplay, for time to first token
claude-profiler uninstall-hooks                 # restores your original settings.json
```

- `install-hooks` shows the `~/.claude/settings.json` diff and asks for confirmation before
  writing it. It backs up your settings first.
- From npm, the hook script is copied to `~/.claude/profiler/hooks/`, so it still works
  after `npx` clears its cache. The standalone build registers itself instead, as
  `claude-profiler hook`, from where it is installed; for Homebrew and Scoop that is the
  path that survives an upgrade (`opt`, `current`). Switching between the two and running `install-hooks`
  again replaces the other one's entries.
- Every hook event starts a short-lived process: about 25ms for the npm script and 60ms
  for the standalone build, which loads the whole CLI. All but `Stop`, `StopFailure` and
  `SessionEnd` run in the background, so Claude Code does not wait for them.
  `--stream-timing` fires many more events, because it runs on each chunk of streamed
  output.
- Events are written to `~/.claude/profiler/<sessionId>.jsonl`, and only as **sizes and
  identifiers**. Prompts, tool inputs, tool results and message text are stored as byte
  counts. The one exception is error and permission-denial messages, which are kept but
  cut to 200 characters.

With hooks installed, you get:

- **Tools** time split into dispatch overhead, your approval decision and execution.
- **Idle** as its own row. When you resume an old session, the days it sat closed are
  moved out of **You**.
- A **Hooks** tab showing failed calls, result sizes per tool and cache-rewrite cost.

## How to read the numbers

- **Tool time includes approvals unless you have hooks.** One call where you stepped away
  can make a tool look slow, so check the **Median** column next to **Total**.
- **Stalled** time is part of Model time. A request is counted as stalled when it ran for
  over a minute and produced tokens at less than one tenth of the session's median rate,
  with a floor of 1 token/s. This usually means the machine slept or the stream hung.
  Failed API calls also count as stalled. Press `x` to exclude stalled time from the
  percentages.
- **Cost** is shown only when the transcript contains Claude Code's own `cost-state`
  record. It is never estimated from token counts. It uses API rates, so on a subscription
  it is not what you pay.
- **The first block of each request** also includes queueing and reading the prompt,
  because the transcript can't separate them. See
  [`docs/otel-model-timing-findings.md`](docs/otel-model-timing-findings.md).

## JSON output

Each run writes a profile to `~/.claude/profiler/profiles/<sessionId>.json`, or to the
path given with `--out`, before it opens the UI. With `--json`, or when stdin is not a
terminal, it writes the file, prints its path and exits.

```sh
cprof 7801be40 --json --out profile.json && jq '.timeline' profile.json
```

- `timeline.modelMs` includes stalled time. Subtract `modelBreakdown.suspectMs` to exclude it.
- `hooks` and `phases` are `null` when the session has no hook data.
- `schemaVersion` is `"0.2"`. The format may change in any `0.x` release, so pin the
  version if you build tools on it.

## Privacy

`claude-profiler` reads local files only and makes no network calls. Its output stays on
your machine.

## Development

```sh
pnpm install
pnpm verify         # build + unit tests
pnpm build:binary   # the standalone executable for this machine (needs Node >= 25.5)
```

`test/corpus.test.ts` runs against your real transcripts in `~/.claude/projects/` and is
skipped when that directory doesn't exist, as in CI.

## License

MIT — see [LICENSE](LICENSE).
