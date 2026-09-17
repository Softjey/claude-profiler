# Progress

One file per `plan.md` task, written by `/verify-task`: `progress/T5.md`.
A task is done only when its file exists and carries a PASS verdict.

One file per task is deliberate — parallel tasks run in separate worktrees and each
writes only its own file, so merging a wave never produces a conflict here.
Never collect these into a single shared log.

Read the whole log with `cat progress/T*.md`.

T1 and T2 predate this skill and have no verification file.
