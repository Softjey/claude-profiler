import { Box, Text, useInput } from "ink";
import type { Profile } from "../artifact/profile.js";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { NavStack } from "./shell.js";
import { formatDateTime, formatMs, summarizeInput, truncate } from "./format.js";
import { callDetailScreen } from "./CallDetail.js";
import { subagentDetailScreen } from "./SubagentDetail.js";

// Each column carries its own marginRight below, so these widths only need
// to fit their content — the gap between columns comes from the margin, not
// from padding inside the width.
const TURN_WIDTH = 4;
const STARTED_WIDTH = 16;
const DURATION_WIDTH = 10;
// Widened at the expense of Turn/Started (T-input-column, 34 -> 39): the
// previous width left almost no room once summarizeInput() stopped hiding
// JSON punctuation behind truncation.
const NAME_WIDTH = 39;
const VISIBLE_ROWS = 15;

function sortCallsByDuration(calls: ToolCall[]): ToolCall[] {
  // unfinished calls (durationMs: null, FR10) sort last rather than first/undefined
  return [...calls].sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
}

export interface CallListProps {
  calls: ToolCall[];
  tool: ExactToolStat;
  profile: Profile;
  nav: NavStack;
  emptyMessage: string;
}

/**
 * The sorted, windowed, drill-into-a-call list shared by ToolDetailScreen
 * (a tool's full call list) and BashGroupCallsScreen (one command group's
 * calls within a Bash tool) — extracted so both stay identical instead of
 * drifting (T-bash-groups).
 */
export function CallList({ calls: rawCalls, tool, profile, nav, emptyMessage }: CallListProps): React.JSX.Element {
  // nav.selection, not local useState: see Overview.tsx's comment on the same
  // pattern — a frame's own state must survive its own remount when a
  // sibling is pushed on top of it and later popped back off.
  const selectedIndex = nav.selection;
  const calls = sortCallsByDuration(rawCalls);
  // Matched by call id, not `tool.kind === "task"`: the subagent-spawning
  // tool is named "Agent" in every real transcript seen locally, never
  // "Task" (resolve-subagents.ts), and `classifyKind` (tool-stats.ts) only
  // special-cases the literal name "Task". Whether a subagent actually
  // resolved is the only reliable signal.
  const subagentByCallId = new Map(profile.subagents.map((s) => [s.parentToolCallId, s]));
  const hasSubagentCalls = calls.some((c) => subagentByCallId.has(c.id));

  // Same windowing as Timeline.tsx's TimelineScreen: without it, a list with
  // more calls than fit on screen just prints every row, and the terminal's
  // own scrollback — not this component — decides what's visible, so the
  // highlighted row can end up off-screen as ↑↓ moves it.
  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, calls.length - VISIBLE_ROWS),
  );
  const visibleCalls = calls.slice(windowStart, windowStart + VISIBLE_ROWS);

  useInput((input, key) => {
    if (calls.length === 0) return;
    if (key.upArrow) {
      nav.setSelection((selectedIndex - 1 + calls.length) % calls.length);
    } else if (key.downArrow) {
      nav.setSelection((selectedIndex + 1) % calls.length);
    } else if (key.return) {
      const call = calls[selectedIndex];
      if (!call) return;
      const subagent = subagentByCallId.get(call.id);
      if (subagent) {
        nav.push(subagentDetailScreen(subagent));
      } else {
        nav.push(callDetailScreen(call, tool));
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={TURN_WIDTH} marginRight={2}>
          <Text bold>Turn</Text>
        </Box>
        <Box width={STARTED_WIDTH} marginRight={2}>
          <Text bold>Started</Text>
        </Box>
        <Box width={DURATION_WIDTH} marginRight={2}>
          <Text bold>Duration</Text>
        </Box>
        <Box width={NAME_WIDTH}>
          <Text bold>Input</Text>
        </Box>
      </Box>
      {calls.length === 0 ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        visibleCalls.map((call, i) => {
          const selected = windowStart + i === selectedIndex;
          const color = selected ? "cyan" : "white";
          const subagent = subagentByCallId.get(call.id);
          return (
            <Box key={call.id}>
              <Box width={TURN_WIDTH} marginRight={2}>
                <Text color={color}>{call.turnIndex}</Text>
              </Box>
              <Box width={STARTED_WIDTH} marginRight={2}>
                <Text color={color}>{formatDateTime(call.startedAt)}</Text>
              </Box>
              <Box width={DURATION_WIDTH} marginRight={2}>
                <Text color={color}>
                  {call.durationMs === null ? "unfinished" : formatMs(call.durationMs)}
                </Text>
              </Box>
              <Box width={NAME_WIDTH}>
                <Text color={color}>
                  {subagent ? `[subagent ${subagent.agentId}] ` : ""}
                  {truncate(summarizeInput(call.inputPreview), NAME_WIDTH - 1)}
                </Text>
              </Box>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ select · ⏎ {hasSubagentCalls ? "open subagent" : "call detail"} · Esc back
        </Text>
      </Box>
    </Box>
  );
}
