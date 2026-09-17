import { Box, Text, useInput } from "ink";
import type { Profile } from "../artifact/profile.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { ContextPoint } from "../metrics/context.js";
import { registerTab, type NavScreen, type ScreenProps } from "./shell.js";
import { formatCount, formatDateTime, formatMs, truncate } from "./format.js";

const VISIBLE_ROWS = 15;

interface TurnRow {
  index: number;
  startMs: number | null;
  toolsMs: number;
  calls: ToolCall[];
}

function parseMs(at: string | null): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One row per user turn (`session.turnCount`, T15's acceptance criterion),
 * built entirely from data the Profile artifact already carries — it has no
 * per-turn duration or user-prompt text of its own (T11's schema stops at
 * the session-level split plus per-tool-call and per-assistant-message
 * series), so this derives what it honestly can from `tool.callRefs` (exact
 * per-call timing) and `context.turns` (per-assistant-message timestamps),
 * grouped by the `turnIndex` both already carry.
 */
function buildTurnRows(profile: Profile): TurnRow[] {
  const rows: TurnRow[] = Array.from({ length: profile.session.turnCount }, (_, index) => ({
    index,
    startMs: null,
    toolsMs: 0,
    calls: [],
  }));

  const noteStart = (row: TurnRow, ms: number | null) => {
    if (ms === null) return;
    if (row.startMs === null || ms < row.startMs) row.startMs = ms;
  };

  for (const tool of profile.tools) {
    for (const call of tool.callRefs) {
      const row = rows[call.turnIndex];
      if (!row) continue;
      row.calls.push(call);
      if (call.durationMs !== null) row.toolsMs += call.durationMs;
      noteStart(row, parseMs(call.startedAt));
    }
  }

  const pointsByTurn = new Map<number, ContextPoint[]>();
  for (const point of profile.context.turns) {
    const list = pointsByTurn.get(point.turnIndex);
    if (list) list.push(point);
    else pointsByTurn.set(point.turnIndex, [point]);
  }
  for (const row of rows) {
    for (const point of pointsByTurn.get(row.index) ?? []) {
      noteStart(row, parseMs(point.at));
    }
  }

  return rows;
}

/** The gap to the next known turn start, or to the session end for the last turn — a wall-clock span, not a processing-time claim (it also folds in whatever idle time preceded the *next* prompt). */
function turnSpanMs(rows: TurnRow[], i: number, sessionEndMs: number | null): number | null {
  const row = rows[i];
  if (!row || row.startMs === null) return null;
  for (let j = i + 1; j < rows.length; j++) {
    const next = rows[j];
    if (next?.startMs !== null && next?.startMs !== undefined) return next.startMs - row.startMs;
  }
  return sessionEndMs !== null ? Math.max(0, sessionEndMs - row.startMs) : null;
}

function activityPreview(row: TurnRow): string {
  if (row.calls.length === 0) return "(no tool calls)";
  const names = [...new Set(row.calls.map((c) => c.name))];
  return names.join(", ");
}

export function TimelineScreen({ profile, nav }: ScreenProps): React.JSX.Element {
  const rows = buildTurnRows(profile);
  const sessionEndMs = parseMs(profile.session.endedAt);
  const selectedIndex = Math.min(nav.selection, Math.max(0, rows.length - 1));

  useInput((_input, key) => {
    if (rows.length === 0) return;
    if (key.upArrow) {
      nav.setSelection((selectedIndex - 1 + rows.length) % rows.length);
    } else if (key.downArrow) {
      nav.setSelection((selectedIndex + 1) % rows.length);
    } else if (key.return) {
      const row = rows[selectedIndex];
      if (row) nav.push(turnDetailScreen(row.index));
    }
  });

  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, rows.length - VISIBLE_ROWS),
  );
  const visible = rows.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Text bold>Timeline — {rows.length} turns</Text>
      <Box marginTop={1}>
        <Box width={5}>
          <Text bold>Turn</Text>
        </Box>
        <Box width={18}>
          <Text bold>Started</Text>
        </Box>
        <Box width={9}>
          <Text bold>Span</Text>
        </Box>
        <Box width={7}>
          <Text bold>Tools</Text>
        </Box>
        <Box width={12}>
          <Text bold>Tools time</Text>
        </Box>
        <Box width={30}>
          <Text bold>Activity</Text>
        </Box>
      </Box>
      {rows.length === 0 ? (
        <Text dimColor>No turns recorded.</Text>
      ) : (
        visible.map((row) => {
          const selected = row.index === selectedIndex;
          const color = selected ? "cyan" : "white";
          const span = turnSpanMs(rows, row.index, sessionEndMs);
          return (
            <Box key={row.index}>
              <Box width={5}>
                <Text color={color}>{row.index}</Text>
              </Box>
              <Box width={18}>
                <Text color={color}>{row.startMs === null ? "—" : formatDateTime(new Date(row.startMs).toISOString())}</Text>
              </Box>
              <Box width={9}>
                <Text color={color}>{span === null ? "—" : formatMs(span)}</Text>
              </Box>
              <Box width={7}>
                <Text color={color}>{row.calls.length}</Text>
              </Box>
              <Box width={12}>
                <Text color={color}>{row.toolsMs > 0 ? formatMs(row.toolsMs) : "—"}</Text>
              </Box>
              <Box width={30}>
                <Text color={color}>{truncate(activityPreview(row), 29)}</Text>
              </Box>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ⏎ expand turn · ⇥ next tab · q quit</Text>
      </Box>
    </Box>
  );
}

/** `⏎` on a Timeline row (plan T15 step 1): every tool call and assistant-message token point in that turn, in time order — the closest honest substitute for "the turn's events" the artifact can produce (no raw event log is retained). */
function TurnDetailScreen({ profile, turnIndex }: ScreenProps & { turnIndex: number }): React.JSX.Element {
  const calls = profile.tools
    .flatMap((tool) => tool.callRefs.filter((c) => c.turnIndex === turnIndex).map((c) => ({ ...c, toolName: tool.name })))
    .sort((a, b) => (parseMs(a.startedAt) ?? 0) - (parseMs(b.startedAt) ?? 0));
  const points = profile.context.turns
    .filter((p) => p.turnIndex === turnIndex)
    .sort((a, b) => (parseMs(a.at) ?? 0) - (parseMs(b.at) ?? 0));

  return (
    <Box flexDirection="column">
      <Text bold>Turn {turnIndex}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Tool calls ({calls.length})</Text>
        {calls.length === 0 ? (
          <Text dimColor>None.</Text>
        ) : (
          calls.map((call) => (
            <Text key={call.id}>
              {formatDateTime(call.startedAt)} · {call.toolName} ·{" "}
              {call.durationMs === null ? "unfinished" : formatMs(call.durationMs)}
              {call.isOutlier ? " (outlier)" : ""}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Assistant messages ({points.length})</Text>
        {points.length === 0 ? (
          <Text dimColor>None.</Text>
        ) : (
          points.map((point, i) => (
            <Text key={`${point.turnIndex}-${i}`}>
              {formatDateTime(point.at)} · cache read {formatCount(point.cacheReadTokens)} · output{" "}
              {formatCount(point.outputTokens)} · thinking {formatCount(point.thinkingTokens)}
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}

function turnDetailScreen(turnIndex: number): NavScreen {
  return {
    id: `turn:${turnIndex}`,
    render: (props) => <TurnDetailScreen {...props} turnIndex={turnIndex} />,
  };
}

registerTab({ id: "timeline", title: "Timeline", render: (props) => <TimelineScreen {...props} /> });
