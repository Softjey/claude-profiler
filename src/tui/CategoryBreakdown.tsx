import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { BlockKind } from "../model/events.js";
import type { ModelBreakdown, PhasePosition } from "../metrics/model-breakdown.js";
import type { UserGap } from "../metrics/time-split.js";
import { formatCount, formatMs, formatPercent, truncate } from "./format.js";

const BAR_WIDTH = 20;
const VISIBLE_ROWS = 15;

function bar(fraction: number, color: string): React.JSX.Element {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * BAR_WIDTH);
  return (
    <Text color={color}>
      {"█".repeat(filled)}
      <Text dimColor>{"░".repeat(Math.max(0, BAR_WIDTH - filled))}</Text>
    </Text>
  );
}

const KIND_LABELS: Record<BlockKind, string> = {
  thinking: "Thinking",
  text: "Writing text",
  tool_use: "Emitting tool calls",
  other: "Other",
};

const KIND_COLORS: Record<BlockKind, string> = {
  thinking: "magenta",
  text: "cyan",
  tool_use: "yellow",
  other: "white",
};

const POSITION_LABELS: Record<PhasePosition, string> = {
  first: "1st block",
  continuation: "later",
};

const PHASE_LABEL_WIDTH = 34;

export interface ModelBreakdownTableProps {
  breakdown: ModelBreakdown;
  selectedIndex: number;
  /** See ToolTableProps.active: only highlight once the cursor is in this table. */
  active: boolean;
}

/**
 * Model's own drill-down. CC writes one record per content block, each with
 * its own timestamp, so each row here is wall-clock that was actually spent
 * on that kind of output — not `modelMs` apportioned by token share, which
 * is what this replaces (model-breakdown.ts).
 *
 * A request's first block is kept as its own row rather than folded in with
 * the rest: its slice also covers queueing the call and reading the prompt
 * back in, and the transcript timestamps the block's end, so there is no
 * honest way to separate the three.
 */
export function ModelBreakdownTable({
  breakdown,
  selectedIndex,
  active,
}: ModelBreakdownTableProps): React.JSX.Element {
  const { coverage, phases, suspectMs, totalMs } = breakdown;

  if (phases.length === 0) {
    return <Text dimColor>No model time recorded in this session.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        measured from per-block record timestamps · {coverage.totalRequests} request
        {coverage.totalRequests === 1 ? "" : "s"}, {coverage.requestsWithBlockSplit} written as more than one block
      </Text>
      {phases.map((phase, i) => {
        const selected = active && i === selectedIndex;
        const label = `${KIND_LABELS[phase.kind]} (${POSITION_LABELS[phase.position]})`;
        return (
          <Box key={`${phase.position}:${phase.kind}`}>
            <Box width={PHASE_LABEL_WIDTH} flexShrink={0}>
              <Text bold={selected} wrap="truncate-end">
                {selected ? ">" : " "} {label}
              </Text>
            </Box>
            {bar(phase.pctOfModel, KIND_COLORS[phase.kind])}
            <Text>
              {" "}
              {formatPercent(phase.pctOfModel)} ({formatMs(phase.ms)}, {phase.slices} slice
              {phase.slices === 1 ? "" : "s"})
            </Text>
          </Box>
        );
      })}
      {suspectMs > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">
            {formatMs(suspectMs)} ({formatPercent(totalMs > 0 ? suspectMs / totalMs : 0)}) of this is probably not the
            model working:
          </Text>
          {breakdown.suspect.map((entry) => (
            <Text key={entry.reason} dimColor>
              {"  "}
              {entry.reason === "api_error"
                ? `${entry.requests} failed API call${entry.requests === 1 ? "" : "s"} CC wrote itself` +
                  (entry.kinds.length > 0 ? ` (${entry.kinds.join(", ")})` : "")
                : `${entry.requests} request${entry.requests === 1 ? "" : "s"} that ran for minutes below ` +
                  `${breakdown.stallThresholdTokensPerSec.toFixed(1)} tok/s — a slept machine or a dropped stream`}
              {" — "}
              {formatMs(entry.ms)}
            </Text>
          ))}
          <Text dimColor>
            {"  "}counted in the rows above, not on top of them: {formatMs(totalMs - suspectMs)} is left that looks
            like generation
          </Text>
        </Box>
      ) : null}
      {breakdown.requests.length > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            slowest request: {formatMs(Math.max(...breakdown.requests.map((r) => r.totalMs)))} ·{" "}
            {formatCount(breakdown.requests.reduce((sum, r) => sum + r.outputTokens, 0))} output tokens over all
            requests
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export interface UserPromptListProps {
  userGaps: UserGap[];
  selectedIndex: number;
  /** See ToolTableProps.active: only highlight once the cursor is in this table. */
  active: boolean;
}

const PROMPT_INDEX_WIDTH = 5;
const PROMPT_PREVIEW_WIDTH = 46;
const PROMPT_TOOK_WIDTH = 9;

/**
 * You's own drill-down: one row per prompt you sent, with how long it took
 * you to write it (the gap between the previous reply ending and this
 * prompt landing) — not a bucketed histogram, so a specific slow reply can
 * actually be identified rather than just counted. `⏎` on a row pushes
 * PromptDetail, which shows the prompt's untruncated text (Overview.tsx).
 */
export function UserPromptList({ userGaps, selectedIndex, active }: UserPromptListProps): React.JSX.Element {
  if (userGaps.length === 0) {
    return <Text dimColor>No prompts follow a reply in this session.</Text>;
  }

  // Same windowing as Timeline.tsx's TimelineScreen / ToolTable.tsx: keeps
  // the highlighted prompt on screen instead of leaving that to the
  // terminal's own scrollback once there are more prompts than fit.
  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, userGaps.length - VISIBLE_ROWS),
  );
  const visibleGaps = userGaps.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {userGaps.length} prompt{userGaps.length === 1 ? "" : "s"}, in order
      </Text>
      <Box marginTop={1}>
        <Box width={PROMPT_INDEX_WIDTH} flexShrink={0}>
          <Text bold>{"  #"}</Text>
        </Box>
        <Box width={PROMPT_PREVIEW_WIDTH} marginRight={2} flexShrink={0}>
          <Text bold>Prompt</Text>
        </Box>
        <Box width={PROMPT_TOOK_WIDTH} flexShrink={0}>
          <Text bold>Took</Text>
        </Box>
      </Box>
      {visibleGaps.map((gap, i) => {
        const absoluteIndex = windowStart + i;
        const selected = active && absoluteIndex === selectedIndex;
        const color = selected ? "cyan" : "white";
        return (
          <Box key={`${absoluteIndex}-${gap.preview}`}>
            <Box width={PROMPT_INDEX_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected}>
                {selected ? ">" : " "} {absoluteIndex + 1}
              </Text>
            </Box>
            <Box width={PROMPT_PREVIEW_WIDTH} marginRight={2} flexShrink={0}>
              <Text color={color} bold={selected} wrap="truncate-end">
                {truncate(gap.preview, PROMPT_PREVIEW_WIDTH)}
              </Text>
            </Box>
            <Box width={PROMPT_TOOK_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected}>
                {formatMs(gap.gapMs)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export interface UnaccountedBreakdownProps {
  timeline: MergedTimeSplit;
  unmatchedToolUses: number;
}

/**
 * Unaccounted's own drill-down: unlike the other three, the transcript
 * carries no further structured signal for this bucket (no compaction or
 * resume events in the data model), so this surfaces the one thing that is
 * known to leak into it — tool calls that started but never recorded a
 * matching result (FR10) — rather than inventing sub-categories the data
 * can't support.
 */
export function UnaccountedBreakdown({ timeline, unmatchedToolUses }: UnaccountedBreakdownProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text>
        {formatMs(timeline.unaccountedMs)} ({formatPercent(timeline.spanMs > 0 ? timeline.unaccountedMs / timeline.spanMs : 0)}) has no known cause
      </Text>
      <Text dimColor>
        {unmatchedToolUses > 0
          ? `${unmatchedToolUses} tool call${unmatchedToolUses === 1 ? "" : "s"} started but never recorded a result — an interrupted or ` +
            "still-running session — and some of that time likely ended up here."
          : "No incomplete tool calls in this session; the rest is rounding and gaps between recorded events."}
      </Text>
    </Box>
  );
}
