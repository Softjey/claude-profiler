import { Box, Text, useInput } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { BashGroupStat } from "../metrics/bash-groups.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { formatDateTime, formatMs, formatPercent, truncate } from "./format.js";
import { callDetailScreen } from "./CallDetail.js";
import { subagentDetailScreen } from "./SubagentDetail.js";

const NAME_WIDTH = 34;
const VISIBLE_ROWS = 15;
const VISIBLE_GROUP_ROWS = 8;

/**
 * Read-only breakdown of a Bash tool's calls by leading command (git, pnpm,
 * find, ...) so a heavy habit shows up on its own instead of hiding inside
 * one aggregate "Bash" row (bash-groups.ts). No selection of its own: it
 * sits above the existing per-call list, which still drills into calls.
 */
function BashGroupsTable({ groups }: { groups: BashGroupStat[] }): React.JSX.Element {
  const rows = groups.slice(0, VISIBLE_GROUP_ROWS);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>By command</Text>
      <Box>
        <Box width={16} flexShrink={0}>
          <Text bold>Group</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text bold>Total</Text>
        </Box>
        <Box width={8} flexShrink={0}>
          <Text bold>%</Text>
        </Box>
        <Box width={7} flexShrink={0}>
          <Text bold>Calls</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text bold>Median</Text>
        </Box>
      </Box>
      {rows.map((group) => (
        <Box key={group.group}>
          <Box width={16} flexShrink={0}>
            <Text wrap="truncate-end">{group.group}</Text>
          </Box>
          <Box width={10} flexShrink={0}>
            <Text>{formatMs(group.totalMs)}</Text>
          </Box>
          <Box width={8} flexShrink={0}>
            <Text>{formatPercent(group.pctOfBash)}</Text>
          </Box>
          <Box width={7} flexShrink={0}>
            <Text>{group.calls}</Text>
          </Box>
          <Box width={10} flexShrink={0}>
            <Text>{formatMs(group.medianMs)}</Text>
          </Box>
        </Box>
      ))}
      {groups.length > VISIBLE_GROUP_ROWS ? (
        <Text dimColor>… and {groups.length - VISIBLE_GROUP_ROWS} more</Text>
      ) : null}
    </Box>
  );
}

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
      {tool.bashGroups && tool.bashGroups.length > 1 ? <BashGroupsTable groups={tool.bashGroups} /> : null}
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
