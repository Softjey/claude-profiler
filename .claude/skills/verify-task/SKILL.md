---
name: verify-task
description: Verify a completed plan.md task (T1–T16) against its own acceptance criteria before committing. Use immediately after finishing any task from plan.md, when the user asks to verify/check a task, or before committing work that closes a T-task. Runs the task's Verify command, checks every acceptance criterion individually, and records a PASS/FAIL verdict in progress.md.
---

# Verify a plan task

Gate between "I wrote the code" and "the task is done". A task is **not** done because
the code compiles — it is done when every acceptance criterion in `plan.md` is observably true.

## Input

The task id, e.g. `T5`. If none was given, infer it from the work just completed and say
which one you picked before proceeding.

## Procedure

Run these in order. Do not skip a step because the previous one passed.

### 1. Re-read the task

Read the `### <id> —` section of `plan.md` in full. Extract, verbatim:
- every bullet under **Acceptance criteria**
- the **Verify** line
- the **Files** list

Do not work from memory of what the task asked. Re-read it.

### 2. Baseline check

```
pnpm verify
```

Build plus the full unit suite. Red here → stop, fix, restart at step 1.

### 3. Task-specific Verify

Run the exact command on the task's **Verify** line. Where that line describes a manual
check ("read the doc", "navigate the TUI"), perform it and record what you actually observed
— not what you expect the code to do.

### 4. Check each acceptance criterion separately

For **every** criterion, one at a time:

- State the criterion.
- Produce **evidence**: a command and its real output, a test name and its result, or a
  concrete observation. A numeric criterion needs the number. `medianMs ≈ 749` means running
  it and reporting what came back.
- Mark `PASS` or `FAIL`.

Rules:
- Never mark PASS by reasoning about the code. Execute something.
- A criterion you cannot check is `BLOCKED`, never `PASS`. Say what blocks it.
- One FAIL fails the task. No partial credit, no "mostly passes".

### 5. Convention check

Quick pass over the task's files against **Conventions** in `plan.md`:
- Layer direction respected (`cli → tui → artifact → metrics → model → parse`), nothing
  lower importing from higher.
- Every duration field ends in `Ms`; every timestamp field ends in `At` and is ISO 8601.
- Parse-level problems increment a diagnostics counter instead of throwing.
- **Honesty rule:** no label or comment calls a derived duration exact.

### 6. Record the verdict

Write **your own file**, `progress/<id>.md` — e.g. `progress/T5.md`. Never append to a
shared log: sibling tasks run in parallel worktrees, and one file per task is what keeps
merging a wave conflict-free. Overwrite your file if re-verifying.

```markdown
## <id> — <task title> — PASS | FAIL
Verified: <YYYY-MM-DD>

| Acceptance criterion | Evidence | Result |
|---|---|---|
| <criterion> | <command / output / observation> | PASS |

Notes: <deviations from plan.md, things deferred, surprises worth knowing later>
```

Record a FAIL verdict too, in the same file. A task that failed verification twice is a
signal the plan was wrong, and that history must survive.

### 7. Report

- **PASS** → say so, then commit (Conventional Commits, English), scoped to this task alone.
- **FAIL** → do **not** commit and do **not** merge the branch. Name the failing criterion and the fix you propose, then stop
  and wait. Do not silently rewrite the acceptance criterion to match the code you wrote:
  if you believe the criterion itself is wrong, say that explicitly and let the user decide.
