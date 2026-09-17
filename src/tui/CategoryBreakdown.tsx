import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import { computeModelSplit } from "../metrics/model-split.js";
import type { TokenBucket } from "../metrics/tokens.js";
import { formatMs, formatPercent } from "./format.js";

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
}

/**
 * Model's own drill-down (F2 follow-up): thinking vs. generation, estimated
 * from each side's share of thinking/output tokens rather than measured —
 * see `computeModelSplit` for why a real wall-clock split isn't possible.
 */
export function ModelSplitTable({ modelMs, tokens }: ModelSplitTableProps): React.JSX.Element {
  const split = computeModelSplit(modelMs, tokens);
  const rows = [
    { label: "Thinking", ms: split.thinkingMs, tokens: split.thinkingTokens, color: "magenta" },
    { label: "Generation", ms: split.generationMs, tokens: split.generationTokens, color: "cyan" },
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>estimated from each turn's share of thinking vs. output tokens, not measured</Text>
      {rows.map((row) => {
        const fraction = modelMs > 0 ? row.ms / modelMs : 0;
        return (
          <Box key={row.label}>
            <Box width={13}>
              <Text>{row.label}</Text>
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

export interface UserGapHistogramProps {
  gapsMs: number[];
}

interface GapBucketDef {
  label: string;
  upperBoundMs: number | null;
}

const GAP_BUCKET_DEFS: GapBucketDef[] = [
  { label: "<10s", upperBoundMs: 10_000 },
  { label: "10-30s", upperBoundMs: 30_000 },
  { label: "30s-1m", upperBoundMs: 60_000 },
  { label: "1-5m", upperBoundMs: 5 * 60_000 },
  { label: "5-15m", upperBoundMs: 15 * 60_000 },
  { label: "15m+", upperBoundMs: null },
];

/**
 * You's own drill-down: a histogram of the gap between each assistant-turn
 * end and the next user prompt (D-follow-up). Buckets are fixed, human-sized
 * ranges rather than an even split, since a handful of long breaks otherwise
 * swamp the many short back-and-forth replies.
 */
export function UserGapHistogram({ gapsMs }: UserGapHistogramProps): React.JSX.Element {
  const buckets = GAP_BUCKET_DEFS.map((def) => ({ ...def, count: 0, totalMs: 0 }));
  for (const gap of gapsMs) {
    const bucket = buckets.find((b) => b.upperBoundMs === null || gap < b.upperBoundMs) ?? buckets[buckets.length - 1];
    if (!bucket) continue;
    bucket.count++;
    bucket.totalMs += gap;
  }
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  if (gapsMs.length === 0) {
    return <Text dimColor>No gaps between replies in this session.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {gapsMs.length} gap{gapsMs.length === 1 ? "" : "s"} between the end of a reply and your next prompt
      </Text>
      {buckets.map((bucket) => (
        <Box key={bucket.label}>
          <Box width={9}>
            <Text>{bucket.label}</Text>
          </Box>
          {bar(bucket.count / maxCount, "green")}
          <Text>
            {" "}
            {bucket.count} · {formatMs(bucket.totalMs)}
          </Text>
        </Box>
      ))}
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
