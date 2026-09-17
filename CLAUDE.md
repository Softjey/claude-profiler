# Workflow

- Commit whenever a logical chunk of work is finished (e.g. a feature, fix, or refactor is complete and working) — don't batch unrelated changes into one commit.
- Write commit messages in English following Conventional Commits format.

# Package manager

**pnpm, not npm.** Worktrees share pnpm's content-addressable store, so parallel task
branches cost almost no extra disk or download time. `pnpm install`, `pnpm verify`,
`pnpm vitest run <path>`. Never create a `package-lock.json`.

# Definition of done

A task from `plan.md` is finished only after `/verify-task <id>` passes and has written
a PASS block to `progress.md`. Compiling is not passing — every acceptance criterion needs
executed evidence. Do not commit a task that failed verification.

Run `pnpm verify` (build + unit tests) before any commit, task or not.
