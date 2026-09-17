import type { ToolUseEvent } from "../model/events.js";
import { median } from "./percentiles.js";

export interface BashGroupStat {
  /** The command's leading executable, e.g. "git", "pnpm", "find". */
  group: string;
  calls: number;
  totalMs: number;
  medianMs: number;
  maxMs: number;
  unfinishedCount: number;
  /** Share of this Bash tool's own total time, not the whole session. */
  pctOfBash: number;
}

// Wrappers whose own name isn't the interesting part of the command; skipped
// (along with any leading VAR=value assignments) to find the real executable.
const WRAPPER_COMMANDS = new Set(["sudo", "env", "nice", "nohup", "time"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function extractCommand(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string" && command.trim().length > 0) return command;
  }
  return undefined;
}

/**
 * The single-token group for a Bash command: its leading executable, after
 * skipping `VAR=value` assignments and no-op wrappers like `sudo`/`env` (D:
 * single-token grouping chosen over a two-token "git status" scheme for now
 * — coarser, but far simpler).
 */
export function extractBashGroup(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && ASSIGNMENT_RE.test(tokens[i] as string)) i++;
  while (i < tokens.length && WRAPPER_COMMANDS.has(tokens[i] as string)) {
    i++;
    while (i < tokens.length && ASSIGNMENT_RE.test(tokens[i] as string)) i++;
  }
  return tokens[i] ?? "(empty)";
}

/**
 * Groups a tool's Bash calls by their leading executable so a heavy `git` or
 * `pnpm` habit shows up on its own, instead of hiding inside one aggregate
 * "Bash" row. Calls whose input has no string `command` field (malformed or
 * unusual records) land in a single "(unknown)" bucket rather than being
 * dropped.
 */
export function computeBashGroups(toolUses: ToolUseEvent[]): BashGroupStat[] {
  const bashCalls = toolUses.filter((t) => t.name === "Bash");
  if (bashCalls.length === 0) return [];

  const bashTotalMs = bashCalls.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);

  const byGroup = new Map<string, ToolUseEvent[]>();
  for (const call of bashCalls) {
    const command = extractCommand(call.input);
    const group = command !== undefined ? extractBashGroup(command) : "(unknown)";
    const existing = byGroup.get(group);
    if (existing) existing.push(call);
    else byGroup.set(group, [call]);
  }

  const stats: BashGroupStat[] = [];
  for (const [group, calls] of byGroup) {
    const durations = calls
      .map((c) => c.durationMs)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);
    const totalMs = durations.reduce((sum, d) => sum + d, 0);

    stats.push({
      group,
      calls: calls.length,
      totalMs,
      medianMs: median(durations),
      maxMs: durations.length > 0 ? (durations[durations.length - 1] as number) : 0,
      unfinishedCount: calls.filter((c) => c.unfinished).length,
      pctOfBash: bashTotalMs > 0 ? totalMs / bashTotalMs : 0,
    });
  }

  return stats.sort((a, b) => b.totalMs - a.totalMs);
}
