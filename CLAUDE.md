# Workflow

- Commit whenever a logical chunk of work is finished (e.g. a feature, fix, or refactor is complete and working) — don't batch unrelated changes into one commit.
- Write commit messages in English following Conventional Commits format.

# Package manager

**pnpm, not npm.** Worktrees share pnpm's content-addressable store, so parallel task
branches cost almost no extra disk or download time. `pnpm install`, `pnpm verify`,
`pnpm vitest run <path>`. Never create a `package-lock.json`.

# Definition of done

A task from `plan.md` is finished only after `/verify-task <id>` passes and has written
a PASS verdict to `progress/<id>.md`. Compiling is not passing — every acceptance criterion needs
executed evidence. Do not commit a task that failed verification.

Run `pnpm verify` (build + unit tests) before any commit, task or not.

# Working in a task worktree

If you are implementing a `plan.md` task in a worktree, finish like this:

1. `/verify-task <id>` → a PASS verdict in `progress/<id>.md`.
2. Commit on your own branch.
3. `scripts/merge-task.sh` — merges your branch into `master` and reports.

**Always merge through that script; never by hand.** `master` is checked out in the main
worktree, so you cannot switch to it here, and sibling tasks are merging concurrently. The
script serializes behind a lock, refuses a branch without a PASS, and resets `master` if the
post-merge `pnpm verify` goes red.

If it refuses, it is telling you something real — fix the cause in this worktree and run it
again. Never work around it by merging manually.

- **Do not push, and do not open a PR**, unless asked.
- **Do not remove your own worktree or branch** — that is for the user to do afterwards.
- **Stay inside your task's Files list.** Reading a sibling's in-progress code is fine;
  editing it is not. If you genuinely need a file outside that list, stop and ask instead
  of reaching for it. A merge conflict means this rule was broken.

