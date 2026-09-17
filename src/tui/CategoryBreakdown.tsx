import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import { computeModelSplit } from "../metrics/model-split.js";
import type { TokenBucket } from "../metrics/tokens.js";
import type { UserGap } from "../metrics/time-split.js";
import { formatMs, formatPercent, truncate } from "./format.js";

const BAR_WIDTH = 20;

function bar(fraction: number, color: string): React.JSX.Element {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * BAR_WIDTH);
  return (
    <Text color={color}>
      {"█".repeat(filled)}
      <Text dimColor>{"░".repeat(Math.max(0, BAR_WIDTH - filled))}</Text>
    </Text>
  );
}

export interface ModelSplitTableProps {
  modelMs: number;
  tokens: TokenBucket;
  selectedIndex: number;
}

/**
 * Model's own drill-down: thinking vs. generation, estimated from each
 * side's share of thinking/output tokens rather than measured — see
 * `computeModelSplit` for why a real wall-clock split isn't possible.
 */
export function ModelSplitTable({ modelMs, tokens, selectedIndex }: ModelSplitTableProps): React.JSX.Element {
  const split = computeModelSplit(modelMs, tokens);
  const rows = [
    { label: "Thinking", ms: split.thinkingMs, tokens: split.thinkingTokens, color: "magenta" },
    { label: "Generation", ms: split.generationMs, tokens: split.generationTokens, color: "cyan" },
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>estimated from each turn's share of thinking vs. output tokens, not measured</Text>
      {rows.map((row, i) => {
        const fraction = modelMs > 0 ? row.ms / modelMs : 0;
        const selected = i === selectedIndex;
        return (
          <Box key={row.label}>
            <Box width={13}>
              <Text bold={selected}>
                {selected ? ">" : " "} {row.label}
              </Text>
            </Box>
            {bar(fraction, row.color)}
            <Text>
              {" "}
              {formatPercent(fraction)} ({formatMs(row.ms)}, {row.tokens.toLocaleString()} tok)
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export interface UserPromptListProps {
  userGaps: UserGap[];
  selectedIndex: number;
}

const PROMPT_PREVIEW_WIDTH = 50;

/**
 * You's own drill-down: one row per prompt you sent, with how long it took
 * you to write it (the gap between the previous reply ending and this
 * prompt landing) — not a bucketed histogram, so a specific slow reply can
 * actually be identified rather than just counted.
 */
export function UserPromptList({ userGaps, selectedIndex }: UserPromptListProps): React.JSX.Element {
  if (userGaps.length === 0) {
    return <Text dimColor>No prompts follow a reply in this session.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {userGaps.length} prompt{userGaps.length === 1 ? "" : "s"}, in order
      </Text>
      <Box>
        <Box width={PROMPT_PREVIEW_WIDTH + 2}>
          <Text bold>Prompt</Text>
        </Box>
        <Box width={10}>
          <Text bold>Took</Text>
        </Box>
      </Box>
      {userGaps.map((gap, i) => {
        const selected = i === selectedIndex;
        const color = selected ? "cyan" : "white";
        return (
          <Box key={`${i}-${gap.preview}`}>
            <Box width={PROMPT_PREVIEW_WIDTH + 2} flexShrink={0}>
              <Text color={color} wrap="truncate-end">
                {selected ? ">" : " "} {truncate(gap.preview, PROMPT_PREVIEW_WIDTH)}
              </Text>
            </Box>
            <Box width={10} flexShrink={0}>
              <Text color={color}>{formatMs(gap.gapMs)}</Text>
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
