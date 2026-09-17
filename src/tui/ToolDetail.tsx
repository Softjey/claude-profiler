import { Box, Text, useInput } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { formatDateTime, formatMs, truncate } from "./format.js";
import { callDetailScreen } from "./CallDetail.js";
import { subagentDetailScreen } from "./SubagentDetail.js";

const NAME_WIDTH = 34;
const VISIBLE_ROWS = 15;

function sortCallsByDuration(calls: ToolCall[]): ToolCall[] {
  // unfinished calls (durationMs: null, FR10) sort last rather than first/undefined
  return [...calls].sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
}

export interface ToolDetailScreenProps extends ScreenProps {
  tool: ExactToolStat;
}

/**
 * Every call for one tool row, sorted by duration desc so a single outlier
 * — like `computer`'s 1064s call (T6/T13's reference session) — sorts to
 * the top instead of hiding among 19 fast ones (T13's step 4 motivation,
 * one level deeper).
 */
export function ToolDetailScreen({ tool, profile, nav }: ToolDetailScreenProps): React.JSX.Element {
  // nav.selection, not local useState: see Overview.tsx's comment on the same
  // pattern — a frame's own state must survive its own remount when a
  // sibling is pushed on top of it and later popped back off.
  const selectedIndex = nav.selection;
  const calls = sortCallsByDuration(tool.callRefs);
  // Matched by call id, not `tool.kind === "task"`: the subagent-spawning
  // tool is named "Agent" in every real transcript seen locally, never
  // "Task" (resolve-subagents.ts), and `classifyKind` (tool-stats.ts) only
  // special-cases the literal name "Task". Whether a subagent actually
  // resolved is the only reliable signal.
  const subagentByCallId = new Map(profile.subagents.map((s) => [s.parentToolCallId, s]));
  const hasSubagentCalls = calls.some((c) => subagentByCallId.has(c.id));

  // Same windowing as Timeline.tsx's TimelineScreen: without it, a tool with
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
      <Text bold>
        {tool.name} — {calls.length} call{calls.length === 1 ? "" : "s"}, {formatMs(tool.totalMs)} total, median{" "}
        {formatMs(tool.medianMs)}
      </Text>
      <Box marginTop={1}>
        <Box width={5}>
          <Text bold>Turn</Text>
        </Box>
        <Box width={18}>
          <Text bold>Started</Text>
        </Box>
        <Box width={10}>
          <Text bold>Duration</Text>
        </Box>
        <Box width={NAME_WIDTH}>
          <Text bold>Input</Text>
        </Box>
      </Box>
      {calls.length === 0 ? (
        <Text dimColor>No calls recorded.</Text>
      ) : (
        visibleCalls.map((call, i) => {
          const selected = windowStart + i === selectedIndex;
          const color = selected ? "cyan" : call.isOutlier ? "red" : "white";
          const subagent = subagentByCallId.get(call.id);
          return (
            <Box key={call.id}>
              <Box width={5}>
                <Text color={color}>{call.turnIndex}</Text>
              </Box>
              <Box width={18}>
                <Text color={color}>{formatDateTime(call.startedAt)}</Text>
              </Box>
              <Box width={10}>
                <Text color={color} bold={call.isOutlier}>
                  {call.isOutlier ? "! " : "  "}
                  {call.durationMs === null ? "unfinished" : formatMs(call.durationMs)}
                </Text>
              </Box>
              <Box width={NAME_WIDTH}>
                <Text color={color}>
                  {subagent ? `[subagent ${subagent.agentId}] ` : ""}
                  {truncate(call.inputPreview, NAME_WIDTH - 1)}
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

export function toolDetailScreen(tool: ExactToolStat): NavScreen {
  return {
    id: `tool:${tool.name}`,
    render: (props) => <ToolDetailScreen {...props} tool={tool} />,
  };
}
