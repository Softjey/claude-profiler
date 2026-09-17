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

If you are implementing a `plan.md` task in a worktree, your work ends at a verified
commit **on your own branch**. Then stop and report.

- **Do not merge, rebase onto, or otherwise touch `master`.** Sibling tasks are running in
  parallel right now; branches are merged one at a time, in wave order, with `pnpm verify`
  after each merge. A branch that merges itself defeats that.
- **Do not push, and do not open a PR**, unless asked.
- **Do not remove your own worktree or branch** — they are the deliverable until merged.
- **Stay inside your task's Files list.** Reading a sibling's in-progress code is fine;
  editing it is not. If you genuinely need a file outside that list, stop and ask instead
  of reaching for it.

