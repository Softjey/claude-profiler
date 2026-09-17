# Hook timing findings (T9)

## Setup

Temporary `PreToolUse`/`PostToolUse` hooks (matcher `*`) were registered via
`.claude/settings.local.json` in a scratch worktree. Each hook ran a small Node script that
read the hook's stdin payload verbatim, stamped it with `Date.now()`, and appended it as one
JSON line to a scratch file — so we'd see exactly what the payload carries rather than assume.

Constraint discovered along the way: Claude Code loads hook config once at session launch,
from the launch directory. Registering hooks in a worktree after a session already started
(via a mid-session `cd`) does **not** pick them up — a fresh session has to be started from
the directory that has the hooks. Worth keeping in mind for `install-hooks` (T10): it only
needs to write `settings.json` before the *next* session starts, not the current one.

A fresh session was started in that worktree in `permission_mode: default` and asked to run
an unallowlisted action. It hit a real approval prompt; the user deliberately waited before
approving.

## Fields the payload actually carries

`PreToolUse`: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`,
`permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`, **`tool_use_id`**.

`PostToolUse`: everything above, plus `tool_response` and a top-level **`duration_ms`**.

`tool_use_id` is present on both events and matches the transcript's `tool_use`/`tool_result`
block ids, so hook events can be correlated back to specific transcript entries — matching by
`tool_use_id` rather than by proximity in time.

## Measured numbers

One captured pair (`tool_use_id: toolu_0137SejqL6WBhDxkfjT9oBgV`, a `Skill` call that required
approval):

| Event | Hook timestamp | Transcript timestamp |
|---|---|---|
| `PreToolUse` / `tool_use` | `2026-09-17T12:44:18.088Z` | `2026-09-17T12:44:18.026Z` |
| `PostToolUse` / `tool_result` | `2026-09-17T12:44:57.037Z` | `2026-09-17T12:44:57.039Z` |
| **span** | **38.949s** | **39.013s** |

The hook span and the transcript span agree to within ~64ms — noise from process-spawn
overhead, not a structural gap. The `PostToolUse` payload's own `duration_ms` field for this
call was **23ms**.

That 23ms is the tool's actual execution time (the skill itself ran almost instantly once
approved); the other ~38.9s of the 38.949s hook span is exactly the deliberate wait before
clicking approve. So:

```
approvalMs = (PostToolUse.at - PreToolUse.at) - PostToolUse.payload.duration_ms
           = 38949 - 23
           = 38926ms   (the operator waited ~39s before approving)
```

## Does `PreToolUse` fire before or after the permission prompt?

**Before.** `PreToolUse` fired at `12:44:18.088Z`, within ~60ms of the transcript's `tool_use`
block — i.e. as soon as the tool call was proposed, well before the human approved it 38.9
seconds later. `PostToolUse` only fires after the tool has actually run (it carries
`tool_response` and the real `duration_ms`), so the full approval wait plus execution time
both land inside the `PreToolUse → PostToolUse` span, and execution time alone is already
broken out by `PostToolUse.duration_ms`.

## Verdict

**Approval wait is isolatable.** Hooks bracket the transcript's `tool_use → tool_result` span
almost exactly, `tool_use_id` lets hook records be matched to specific transcript entries
rather than guessed by proximity, and `PostToolUse.duration_ms` already separates tool
execution time from the wait that came before it. T10 can compute both:

- `exactMs` — the tool's real execution time, straight from `PostToolUse.duration_ms`.
- `approvalMs` — `(PostToolUse.at - PreToolUse.at) - exactMs`, only defined when a matching
  hook pair exists for that `tool_use_id` (a sidecar with no pair for a call just means no
  hook data for it, not zero approval time).

`approvalMs` should stay in the artifact and the UI; T10 does not need to narrow its scope.
