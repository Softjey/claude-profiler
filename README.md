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

On a Mac there is also a [menu bar app](#menu-bar-app-macos) that watches every running
session at once:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/menu-dark.png">
    <img src="docs/screenshots/menu.png" width="400" alt="The menu bar popover: running sessions with their tokens, CPU, memory, Go to Chat and Free buttons, and today's ended sessions">
  </picture>
</p>

## Install

Pick one. Every method gives you the same program, under both names: `claude-profiler`
and the short `cprof`.

| You have | Use | Command |
| --- | --- | --- |
| Node.js 22+ | npx (no install) | `npx claude-profiler <query>` |
| Node.js 22+ | npm, global | `npm install -g claude-profiler` |
| macOS or Linux, Homebrew | Homebrew | `brew install softjey/tap/claude-profiler` |
| macOS or Linux | install script | `curl -fsSL https://raw.githubusercontent.com/Softjey/claude-profiler/master/install.sh \| sh` |
| Windows, Scoop | Scoop | `scoop bucket add softjey https://github.com/Softjey/scoop-bucket` then `scoop install claude-profiler` |
| Windows | install script | `irm https://raw.githubusercontent.com/Softjey/claude-profiler/master/install.ps1 \| iex` |
| Anything else | download by hand | a `claude-profiler-cli-*` archive from the [releases](https://github.com/Softjey/claude-profiler/releases) page |
| A Mac, and you want it in the menu bar | the app | `Claude-Profiler-App-macos-*.dmg` from the [latest release](https://github.com/Softjey/claude-profiler/releases/latest); see [Menu bar app](#menu-bar-app-macos) |

The `npx` and `npm` methods need Node.js 22 or newer. The rest are the **standalone build**:
one executable that carries its own Node, so nothing else has to be installed. It exists
for macOS, Linux and Windows, on arm64 and x64.

The **menu bar app** is a separate download, for macOS only. It is not needed to use the
terminal UI, and the terminal UI is not needed to use it: the app carries its own collector.

Check that it worked:

```sh
claude-profiler --version
```

### Update

| Installed with | Update with |
| --- | --- |
| npx | nothing to do; `npx claude-profiler@latest` forces a fresh copy |
| npm | `npm install -g claude-profiler@latest` |
| Homebrew | `brew upgrade claude-profiler` |
| Scoop | `scoop update claude-profiler` |
| install script | run it again; it upgrades in place, so hooks you registered keep working |
| menu bar app | quit it, then replace it with the new release's `Claude Profiler.app` |

### Uninstall

Remove the hooks first if you registered any, so Claude Code is not left pointing at a
program that is gone:

```sh
claude-profiler uninstall-hooks
```

Then remove the program the way you installed it: `npm uninstall -g claude-profiler`,
`brew uninstall claude-profiler`, `scoop uninstall claude-profiler`, or, for the install
scripts, delete `claude-profiler` and `cprof` from the install directory. The menu bar app is
removed by turning off **Launch at login** in its settings, quitting it and moving
`Claude Profiler.app` to the Trash.

## What it looks like

Captured from a real 30-minute session (session id and project path replaced):

```text
Fix the flaky upload test
Session  1c128c06-…
Project  ~/code/my-app
Ran      2026-09-19 21:07 · span 30m · 12 turns · 143 requests
Usage    26M tokens · cost — · Opus 5

[1/7] Overview  Tools  Model  Timeline  Context  Hooks  Subagents

  Model      ███████░░░░░░░░░░░░░░░░░░░░░░░ 25% (7m 20s)
> Tools      ██████████░░░░░░░░░░░░░░░░░░░░ 32% (9m 39s)
  You        █████████████░░░░░░░░░░░░░░░░░ 43% (12m 44s)
  Unaccounted░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0.1% (1.6s)

3 tools · 121 calls
Bash                  ████████████████████ 9m 30s (59×, 32%)
WebFetch              ░░░░░░░░░░░░░░░░░░░░ 6.4s (1×, 0.4%)
Edit                  ░░░░░░░░░░░░░░░░░░░░ 2.3s (2×, 0.1%)

↑↓ category · ⏎ Tools tab · ←→ tabs · q quit
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

Seven tabs; `←` `→` switches between them, at any depth. They are the same seven, in the
same order, as the [menu bar app](#menu-bar-app-macos) — the two read the same profile
artifact, so a figure that appears in both is the same number, formatted the same way.

| Tab | What it shows |
| --- | --- |
| Overview | The time split, and what each bucket holds: your prompts and how long each took to write, the unaccounted causes, the heaviest tools, the token mix |
| Tools | Every tool, sortable and filterable, then a tool's calls, then one call |
| Model | One row per API request, or the same time rolled up by cause, model and effort |
| Timeline | One row per turn: when it started, its span, model time, tool time and the prompt that started it |
| Context | Context, output and thinking per request, plus the session totals |
| Hooks | What only hooks record: approval time, retry tax, result sizes, cache rewrites, lifecycle, slash-command cost, streaming, loaded instructions |
| Subagents | Every subagent, with its own split, tools and calls |

Drilling in:

- **Overview → Model / Tools** opens that bucket's own tab. **You** and **Unaccounted**
  open in place, and `⏎` on a prompt shows its full text.
- **Tools → a tool → a call**: calls sorted by duration, then one call's input. `v` on
  **Bash** cycles by-recipe, by-command and the raw call list. An **Agent** or **Task**
  call opens its subagent.
- **Model → a request**: everything the transcript knows about one API call, including
  what it wrote.

  ```text
    #   Started   Total    1st blk  Out    tok/s   Ctx     Cause
  > 23  21:14:02  27s      3.3s     4.0k   146.0   74k     after Bash
    21  21:14:31  23s      4.9s     3.1k   138.1   69k     after Bash
    19  21:14:58  20s      19s      2.1k   101.2   61k     after Bash
  ```

  `v` switches to the same time grouped by cause, model and thinking effort.
- **Timeline → a turn**: every tool call and assistant message in it, in order.

### Keys

| Key | Action |
| --- | --- |
| `←` `→` | Switch tabs — always, drilled in or not |
| `↑` `↓` | Move the selection |
| `⏎` | Go deeper, or open the tab that owns the selected bucket |
| `Esc` | Go back one level |
| `v` | Switch a screen's own view (Bash lenses, Model requests vs. rollups) |
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

## Menu bar app (macOS)

`claude-profiler` profiles one session after the fact. The menu bar app answers the other
question — **what is running right now** — for every Claude Code front end at once: the
CLI, the VS Code extension and Claude Desktop's Code tab all run the same binary and write
the same files, so one collector covers all three.

### Install

Download `Claude-Profiler-App-macos-arm64.dmg` (Apple Silicon) or
`Claude-Profiler-App-macos-x64.dmg` (Intel) from the
[latest release](https://github.com/Softjey/claude-profiler/releases/latest), open it and
drag **Claude Profiler** onto the Applications shortcut next to it, then open the app.
macOS 14 or later; it needs no Node.
Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" is arm64.

It is signed with a Developer ID certificate and notarized by Apple, so it opens with a
double click. `checksums-app.txt` on the release has the SHA-256 of each disk image.

If you build it yourself it is signed ad hoc instead, and macOS asks once: right click →
**Open** (macOS 14), or on macOS 15 and later **System Settings → Privacy & Security →
Open Anyway**. You need Node >= 25.5 and a Swift toolchain; the Command Line Tools are
enough:

```sh
macos/scripts/bundle.sh         # → macos/build/Claude Profiler.app
open "macos/build/Claude Profiler.app"
```

The menu bar shows how many sessions are working and today's token total. The popover
lists each session with its source, state, model, context size, tokens, CPU and memory,
plus a tokens-per-minute sparkline and — with hooks installed — the tool running right
now. Optional notifications fire when Claude finishes a long run or waits for approval.

Each running session has two buttons:

- **Go to Chat** brings that chat forward wherever it lives. The app walks up from the
  session's process to the app that runs it: in VS Code (or Cursor, Windsurf) it opens the
  session's tab through the Claude Code extension, in Claude Desktop it opens the Code
  session, in Terminal or iTerm2 it selects the tab the session writes to (macOS asks once
  for permission to control it), and any other terminal is brought to the front. On an
  ended session the same item, in the right-click menu, resumes it instead.
- **Free *N* MB** quits the session's Claude Code process so macOS gets its memory back.
  The chat itself stays on disk; right click → **Copy Resume Command** gives
  `claude --resume <id>` to pick it up later. Before signalling, the app checks that the
  pid still belongs to that session, so a recycled pid is never touched.

Settings → **Memory** can do the same on its own: **Free idle sessions automatically**
frees a session once it has sat idle past a threshold you pick and holds at least the
memory you pick. It is off by default. Only idle sessions count, and a minute of real CPU
load in the session's process tree, like a background build, restarts the idle clock.
Sessions with an open detail window are kept. By default only terminal sessions are freed,
because an editor or the desktop app shows an error when its process goes away. A
notification says what was freed, and an ended session the app quit is marked "freed" or
"auto-freed" in the list and in its window.

Click a session and you get **everything the terminal UI has**, for that session, kept up
to date as it runs — the app asks the collector for the same profile artifact the CLI
builds, so no metric is computed twice. The tabs are [the same seven](#screens), in the
same order, showing the same figures; only the input differs, since a window can offer a
column header to sort by and a terminal cannot:

| Tab | In the app |
| --- | --- |
| Overview | The split bar, with clickable Model and Tools buckets and a toggle for stalled time; resumes; your prompts; the unaccounted causes; the heaviest tools; the token mix |
| Tools | The full table, sortable by any column and filterable, with the selected tool's calls, its Bash lenses, and a call's own detail |
| Model | Five views of the Model bucket: the token split (by type), the time by cause, by model and by effort, and one row per request — click one for its full detail |
| Timeline | One row per turn, with its span and its model/tool split; click a turn for its whole prompt and its events |
| Context | Context and output per request as charts, with min/max/final and the session totals |
| Hooks | All eleven sections, the same ones the terminal UI prints |
| Subagents | Each subagent's own split, tools and calls |

<table>
  <tr>
    <td><img src="docs/screenshots/detail-overview.png" alt="Overview tab"><br><sub><b>Overview</b> — where the time went</sub></td>
    <td><img src="docs/screenshots/detail-tools.png" alt="Tools tab"><br><sub><b>Tools</b> — per-tool table</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/detail-model.png" alt="Model tab"><br><sub><b>Model</b> — token split and request views</sub></td>
    <td><img src="docs/screenshots/detail-timeline.png" alt="Timeline tab"><br><sub><b>Timeline</b> — one row per turn</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/detail-context.png" alt="Context tab"><br><sub><b>Context</b> — context and output per request</sub></td>
    <td><img src="docs/screenshots/detail-hooks.png" alt="Hooks tab"><br><sub><b>Hooks</b> — approvals, result sizes, parallelism, cache rewrites</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/detail-subagents.png" alt="Subagents tab"><br><sub><b>Subagents</b> — each subagent's own split</sub></td>
    <td><img src="docs/screenshots/detail-overview-dark.png" alt="Overview tab in dark mode"><br><sub>Dark mode</sub></td>
  </tr>
</table>

The screenshots come from a session recorded on a throwaway demo project, with a made-up
session list around it — none of them show a real session.

**If you can't find the icon**, your menu bar is full: macOS drops the items that do not
fit, silently, and a newly launched app goes to the back of the queue. The same window is
always reachable without it:

```sh
open -a "Claude Profiler"   # opens the session list, icon or no icon
```

It also opens by itself on first launch. To win back space, quit another menu bar app, or
set **Show → Icon only** in the app's settings. An app with long menus, such as VS Code,
takes room from the same bar, so an item that is hidden there can reappear in Finder.

What it reads, every one to five seconds:

| Source | What it gives |
| --- | --- |
| `~/.claude/projects/**/*.jsonl` | tokens, context size, model, title, subagents |
| `~/.claude/sessions/<pid>.json` | which sessions are running, and busy vs. idle |
| `ps` over each session's process tree | CPU and memory, including MCP servers and tools |
| `~/.claude/profiler/<id>.jsonl` | the running tool and pending approvals (needs hooks) |

Notes and limits:

- **Regular Claude Desktop chats are not shown.** They run on Anthropic's servers and
  leave no local token record. Desktop's Code tab is shown in full.
- **Cost stays blank for live sessions.** Claude Code writes its `cost-state` record only
  when the session's process exits, so a running one — and one that was killed — has none,
  and this tool never estimates cost from tokens.
- `~/.claude/sessions/` is Claude Code's own internal format. Every field is treated as
  optional, and a file that does not parse is skipped.
- It bundles the collector as a Node single executable, so the machine running it needs
  no Node. Only building it does: Node >= 25.5 (for `node --build-sea`) and a Swift
  toolchain; the Command Line Tools are enough, Xcode is not required.

### The collector on its own

```sh
claude-profiler live          # NDJSON snapshot stream, one line per change
claude-profiler live --once   # one snapshot, then exit
```

Each line is a complete snapshot — a consumer never merges deltas. Send
`{"cmd":"rate","ms":1000}` on stdin to change the polling interval, `{"cmd":"refresh"}`
to force one now, or `{"cmd":"profile","id":"<session>"}` to get that session's full
profile artifact back on the same stream — the object `--json` writes, rebuilt only once
the transcript has grown. The collector exits when its stdin closes, so it never outlives the app
that spawned it. The shapes are in [`src/live/protocol.ts`](src/live/protocol.ts).

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
pnpm macos:test     # Swift tests for the menu bar app
pnpm macos:build    # assemble Claude Profiler.app
```

While working on the app, point it at a collector built from the checkout instead of the
bundled one, and render a view to a PNG without clicking through the menu bar:

```sh
export CPROF_LIVE="node $PWD/dist/live/main.js"
swift run --package-path macos ClaudeProfilerBar
macos/.build/debug/ClaudeProfilerBar --render-png shot.png [--tab tools] [--dark]
```

`--render-png` draws the popover, or a detail tab with `--tab`, from real collector data,
or with `--fixture <dir>` from a saved snapshot and profile instead.
`macos/scripts/screenshots.sh` renders every README screenshot that way from
[`macos/fixtures/demo`](macos/fixtures/demo), so none of them show a real session.
`CPROF_PROFILE_JSON=<a --json artifact> pnpm macos:test` additionally checks that the
Swift models still decode a profile from one of your own sessions.

`test/corpus.test.ts` runs against your real transcripts in `~/.claude/projects/` and is
skipped when that directory doesn't exist, as in CI.

## License

MIT — see [LICENSE](LICENSE).
