import type { ToolUseEvent } from "../model/events.js";
import { computeBashCommandGroups, computeBashGroups, type BashGroupStat } from "./bash-groups.js";
import { median, percentile } from "./percentiles.js";

export type ToolKind = "builtin" | "mcp" | "task";

export interface ToolCall {
  id: string;
  name: string;
  turnIndex: number;
  startedAt: string | null;
  durationMs: number | null;
  inputPreview: string;
}

export interface ToolStat {
  name: string;
  kind: ToolKind;
  mcpServer: string | undefined;
  calls: number;
  totalMs: number;
  typicalMs: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
  unfinishedCount: number;
  pctOfSession: number;
  callRefs: ToolCall[];
  /**
   * Only populated for `name === "Bash"`: the calls grouped by recipe — the
   * set of real commands each call ran — reconciling to this tool's own total.
   */
  bashGroups?: BashGroupStat[];
  /**
   * Only populated for `name === "Bash"`: the same calls keyed by individual
   * command, each counted towards every command it ran. Deliberately
   * over-sums; see `computeBashCommandGroups`.
   */
  bashCommands?: BashGroupStat[];
}

// Large enough that the call-detail pane's JSON.parse succeeds on realistic
// tool inputs (e.g. AskUserQuestion's multi-question payloads), not just the
// short ones — the table row still truncates further via NAME_WIDTH
// (ToolDetail.tsx).
const INPUT_PREVIEW_MAX_CHARS = 4000;

function classifyKind(name: string): { kind: ToolKind; mcpServer: string | undefined } {
  if (name === "Task") return { kind: "task", mcpServer: undefined };
  if (name.startsWith("mcp__")) {
    const [, server] = name.split("__");
    return { kind: "mcp", mcpServer: server };
  }
  return { kind: "builtin", mcpServer: undefined };
}

function truncateInputPreview(input: unknown): string {
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? null);
  return raw.length > INPUT_PREVIEW_MAX_CHARS ? raw.slice(0, INPUT_PREVIEW_MAX_CHARS) : raw;
}

/**
 * Groups matched tool_use events by name and computes the outlier-resistant
 * stats the tool table needs: median/p90/max alongside the raw sum, so a
 * single stuck call never masquerades as the tool's typical cost (FR11, FR12).
 */
export function computeToolStats(toolUses: ToolUseEvent[], spanMs: number): ToolStat[] {
  const byName = new Map<string, ToolUseEvent[]>();
  for (const event of toolUses) {
    const group = byName.get(event.name);
    if (group) {
      group.push(event);
    } else {
      byName.set(event.name, [event]);
    }
  }

  const stats: ToolStat[] = [];

  for (const [name, events] of byName) {
    const { kind, mcpServer } = classifyKind(name);
    const durations = events
      .map((e) => e.durationMs)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);

    const medianMs = median(durations);
    const p90Ms = percentile(durations, 0.9);
    const maxMs = durations.length > 0 ? (durations[durations.length - 1] as number) : 0;
    const totalMs = durations.reduce((sum, d) => sum + d, 0);
    const unfinishedCount = events.filter((e) => e.unfinished).length;

    const callRefs: ToolCall[] = events.map((event) => ({
      id: event.id,
      name: event.name,
      turnIndex: event.turnIndex,
      startedAt: event.startedAt,
      durationMs: event.durationMs,
      inputPreview: truncateInputPreview(event.input),
    }));

    stats.push({
      name,
      kind,
      mcpServer,
      calls: events.length,
      totalMs,
      typicalMs: medianMs * events.length,
      medianMs,
      p90Ms,
      maxMs,
      unfinishedCount,
      pctOfSession: spanMs > 0 ? totalMs / spanMs : 0,
      callRefs,
      ...(name === "Bash"
        ? { bashGroups: computeBashGroups(events), bashCommands: computeBashCommandGroups(events) }
        : {}),
    });
  }

  return stats.sort((a, b) => b.totalMs - a.totalMs);
}
