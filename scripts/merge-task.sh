#!/usr/bin/env bash
# Merge a finished task branch into master, safely, from inside its worktree.
#
# master is checked out in the main worktree, so a linked worktree cannot switch to it —
# the merge has to happen over there. Parallel task agents would then race for master and
# for .git/index.lock, so this serializes them behind one lock and verifies every merge
# before it is allowed to stand.
#
# Usage: scripts/merge-task.sh          (run from the task's worktree, on the task branch)

set -euo pipefail

MAIN="$(dirname "$(git rev-parse --git-common-dir)")"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
LOCK="$(git rev-parse --git-common-dir)/task-merge.lock"
LOCK_TIMEOUT=1800   # a sibling's merge+verify should never take 30 min

die() { echo "merge-task: $*" >&2; exit 1; }

# --- preconditions, before taking the lock -----------------------------------

[ "$BRANCH" != "master" ] && [ "$BRANCH" != "HEAD" ] || die "not on a task branch (HEAD is '$BRANCH')"
[ -z "$(git status --porcelain)" ] || die "this worktree has uncommitted changes — commit them first"

# The verification gate, enforced rather than trusted: the branch must add a progress
# file, and that file must record a PASS.
# (portable to bash 3.2, which is what macOS ships — no mapfile)
PROGRESS="$(git diff --name-only master...HEAD -- 'progress/T*.md')"
[ -n "$PROGRESS" ] || die "no progress/T*.md on this branch — run /verify-task before merging"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  git show "HEAD:$f" | grep -q 'PASS' || die "$f does not record a PASS — not merging a failed task"
done <<EOF
$PROGRESS
EOF

# --- serialize ---------------------------------------------------------------

waited=0
until mkdir "$LOCK" 2>/dev/null; do
  [ "$waited" -lt "$LOCK_TIMEOUT" ] || die "timed out after ${LOCK_TIMEOUT}s waiting for $LOCK
If no sibling merge is running, the lock is stale: rm -rf '$LOCK'"
  [ "$waited" -eq 0 ] && echo "merge-task: another task is merging; waiting…"
  sleep 5
  waited=$((waited + 5))
done
trap 'rm -rf "$LOCK"' EXIT
echo "merge-task: lock acquired, merging $BRANCH into master"

# --- merge, in the main worktree ---------------------------------------------

[ -z "$(git -C "$MAIN" status --porcelain)" ] \
  || die "the main worktree has uncommitted changes — not merging into a dirty tree"

BEFORE="$(git -C "$MAIN" rev-parse HEAD)"

if ! git -C "$MAIN" merge --no-ff --no-edit "$BRANCH"; then
  git -C "$MAIN" merge --abort || true
  die "conflict merging $BRANCH.
Two tasks touched the same file, which means one widened its Files list in plan.md.
That is not settled during a merge — master is untouched, re-scope the task."
fi

# A branch that is green alone can still be red beside a sibling's merged work.
if ! (cd "$MAIN" && pnpm install --silent && pnpm verify); then
  git -C "$MAIN" reset --hard "$BEFORE"
  die "merged cleanly but pnpm verify failed; master reset to $BEFORE.
Your branch is intact — fix it in this worktree and run this script again."
fi

echo "merge-task: $BRANCH merged into master, verify green"
echo "merge-task: leaving the worktree in place; remove it with 'git worktree remove'"
