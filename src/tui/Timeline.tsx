import { Box, Text, useInput } from "ink";
import type { Profile } from "../artifact/profile.js";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { ContextPoint } from "../metrics/context.js";
import { registerTab, type NavScreen, type ScreenProps } from "./shell.js";
import { formatCount, formatDateTime, formatMs, truncate } from "./format.js";
import { callDetailScreen } from "./CallDetail.js";
import { promptPointDetailScreen } from "./PromptPointDetail.js";

const VISIBLE_ROWS = 15;

interface TurnRow {
  index: number;
  startMs: number | null;
  toolsMs: number;
  calls: ToolCall[];
  trigger: string | null;
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
    trigger: null,
  }));

  const noteStart = (row: TurnRow, ms: number | null) => {
    if (ms === null) return;
    if (row.startMs === null || ms < row.startMs) row.startMs = ms;
  };

  for (const prompt of profile.prompts) {
    const row = rows[prompt.turnIndex];
    if (!row) continue;
    row.trigger = prompt.preview;
    noteStart(row, parseMs(prompt.at));
  }

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

function triggerPreview(row: TurnRow): string {
  return row.trigger ?? "(no prompt captured)";
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
        <Box width={38}>
          <Text bold>Trigger</Text>
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
              <Box width={38}>
                <Text color={color}>{truncate(triggerPreview(row), 37)}</Text>
              </Box>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ⏎ expand turn · ←→ tabs · q quit</Text>
      </Box>
    </Box>
  );
}

interface TurnEvent {
  key: string;
  atMs: number | null;
  render: (selected: boolean) => React.JSX.Element;
  open: (nav: ScreenProps["nav"]) => void;
}

function callTurnEvent(call: ToolCall, tool: ExactToolStat): TurnEvent {
  return {
    key: call.id,
    atMs: parseMs(call.startedAt),
    render: (selected) => (
      <Text {...(selected ? { color: "cyan" as const } : {})}>
        {selected ? "> " : "  "}
        {formatDateTime(call.startedAt)} · {tool.name} ·{" "}
        {call.durationMs === null ? "unfinished" : formatMs(call.durationMs)}
      </Text>
    ),
    open: (nav) => nav.push(callDetailScreen(call, tool)),
  };
}

function assistantTurnEvent(point: ContextPoint, key: string): TurnEvent {
  return {
    key,
    atMs: parseMs(point.at),
    render: (selected) => (
      <Text {...(selected ? { color: "cyan" as const } : {})}>
        {selected ? "> " : "  "}
        {formatDateTime(point.at)} · assistant message · cache read {formatCount(point.cacheReadTokens)} · output{" "}
        {formatCount(point.outputTokens)} · thinking {formatCount(point.thinkingTokens)}
      </Text>
    ),
    open: (nav) => nav.push(promptPointDetailScreen(point)),
  };
}

/** `⏎` on a Timeline row (plan T15 step 1): every tool call and assistant-message token point in that turn, merged into one time-ordered, scrollable list — the closest honest substitute for "the turn's events" the artifact can produce (no raw event log is retained). Each row drills further in on `⏎`. */
function TurnDetailScreen({ profile, turnIndex, nav }: ScreenProps & { turnIndex: number }): React.JSX.Element {
  // nav.selection, not local useState: see Overview.tsx's comment on the same pattern.
  const selectedIndex = nav.selection;
  const trigger = profile.prompts.find((p) => p.turnIndex === turnIndex)?.preview ?? null;

  const callEvents = profile.tools.flatMap((tool) =>
    tool.callRefs.filter((c) => c.turnIndex === turnIndex).map((c) => callTurnEvent(c, tool)),
  );
  const assistantEvents = profile.context.turns
    .filter((p) => p.turnIndex === turnIndex)
    .map((p, i) => assistantTurnEvent(p, `assistant-${turnIndex}-${i}`));
  const events = [...callEvents, ...assistantEvents].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));

  useInput((_input, key) => {
    if (events.length === 0) return;
    if (key.upArrow) {
      nav.setSelection((selectedIndex - 1 + events.length) % events.length);
    } else if (key.downArrow) {
      nav.setSelection((selectedIndex + 1) % events.length);
    } else if (key.return) {
      events[selectedIndex]?.open(nav);
    }
  });

  // Same windowing as TimelineScreen above: without it a turn with more
  // events than fit on screen just prints every row and leaves the
  // highlighted one to the terminal's own scrollback.
  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, events.length - VISIBLE_ROWS),
  );
  const visibleEvents = events.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Text bold>Turn {turnIndex}</Text>
      <Text dimColor wrap="wrap">
        Triggered by: {trigger ?? "(no prompt captured)"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Events ({events.length})</Text>
        {events.length === 0 ? (
          <Text dimColor>None.</Text>
        ) : (
          visibleEvents.map((event, i) => <Box key={event.key}>{event.render(windowStart + i === selectedIndex)}</Box>)
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{events.length > 0 ? "↑↓ select · ⏎ drill in · " : ""}Esc back</Text>
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
