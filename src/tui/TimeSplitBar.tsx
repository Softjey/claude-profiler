import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { PhaseSplit } from "../metrics/session-phases.js";
import { formatMs, formatPercent } from "./format.js";

const BAR_WIDTH = 30;

export const CATEGORY_KEYS = ["model", "tools", "you", "unaccounted"] as const;
export type Category = (typeof CATEGORY_KEYS)[number];

/**
 * `idle` and `stalled` are deliberately outside `Category`: neither is
 * drillable — there is nothing underneath idle but "the session was closed",
 * and stalled time is already itemised inside Model's own drill-down.
 * Keeping them out also leaves the ←→ category cycle exactly four stops long.
 */
type SegmentKey = Category | "idle" | "stalled";

interface Segment {
  key: SegmentKey;
  label: string;
  ms: number;
  color: string;
}

function bar(fraction: number, color: string): React.JSX.Element {
  const filled = Math.round(fraction * BAR_WIDTH);
  return (
    <Text color={color}>
      {"█".repeat(filled)}
      <Text dimColor>{"░".repeat(Math.max(0, BAR_WIDTH - filled))}</Text>
    </Text>
  );
}

export interface TimeSplitBarProps {
  timeline: MergedTimeSplit;
  /** Highlights one row and marks it with `>`, the way `ToolTable` marks its selected row (omit for no selection). */
  activeCategory?: Category;
  /**
   * When a hook sidecar named a resume, the same span with session-idle time
   * carved out of "You". Passing it adds an Idle row and reports the corrected
   * "You" instead of the derived one — a resumed session otherwise shows days
   * of closed-laptop time as though a person had been thinking (see
   * session-phases.ts).
   */
  phases?: PhaseSplit | null;
  /**
   * `ModelBreakdown.suspectMs`: model time that was probably not the model
   * working — a request that ran for hours below a tenth of the session's own
   * token rate, or a call CC itself recorded as failed. Passing it splits that
   * time out of Model into a row of its own, because a single slept laptop can
   * be three quarters of the Model bucket and make every other percentage on
   * the screen unreadable.
   */
  stalledMs?: number;
  /**
   * Drop the stalled time from the span as well as from Model, so every
   * percentage describes the time the session was demonstrably working. The
   * bucket totals stay mutually exclusive either way: suspect time is a subset
   * of Model by construction (model-breakdown.ts), so it is only ever moved
   * out of that one bucket, never invented or double-counted.
   */
  excludeStalled?: boolean;
}

/**
 * The headline Model / Tools+approvals / You / unaccounted split (F2, D10),
 * always shown as percentages of the span so the rows sum to 100% regardless
 * of rounding on any individual bar. Each row but Idle is drillable: the
 * caller renders a breakdown table for whichever `activeCategory` it tracks.
 */
export function TimeSplitBar({
  timeline,
  activeCategory,
  phases,
  stalledMs = 0,
  excludeStalled = false,
}: TimeSplitBarProps): React.JSX.Element {
  const { modelMs, toolsMs } = timeline;
  const corrected = phases ?? null;
  const userMs = corrected ? corrected.userMs : timeline.userMs;
  const unaccountedMs = corrected ? corrected.unaccountedMs : timeline.unaccountedMs;

  // Clamped to the bucket it comes out of: `suspectMs` is a subset of Model by
  // construction, and anything that broke that should render a short bar
  // rather than a negative one.
  const stalled = Math.min(Math.max(0, stalledMs), modelMs);
  const workingModelMs = modelMs - stalled;
  const spanMs = excludeStalled ? Math.max(0, timeline.spanMs - stalled) : timeline.spanMs;

  const segments: Segment[] = [
    { key: "model", label: "Model", ms: workingModelMs, color: "cyan" },
    { key: "tools", label: "Tools", ms: toolsMs, color: "yellow" },
    { key: "you", label: "You", ms: userMs, color: "green" },
    ...(corrected ? [{ key: "idle" as const, label: "Idle", ms: corrected.idleMs, color: "magenta" }] : []),
    // Deliberately the quietest colour on the bar. The row can be three
    // quarters of a session, and a red block that size reads as an alarm about
    // something the person did wrong, when all it says is that the laptop was
    // asleep.
    ...(stalled > 0 && !excludeStalled
      ? [{ key: "stalled" as const, label: "Stalled", ms: stalled, color: "gray" }]
      : []),
    { key: "unaccounted", label: "Unaccounted", ms: unaccountedMs, color: "gray" },
  ];

  return (
    <Box flexDirection="column">
      {segments.map((segment) => {
        const fraction = spanMs > 0 ? segment.ms / spanMs : 0;
        const selected = segment.key === activeCategory;
        return (
          <Box key={segment.key}>
            <Box width={13}>
              <Text bold={selected}>
                {selected ? ">" : " "} {segment.label}
              </Text>
            </Box>
            {bar(fraction, segment.color)}
            <Text>
              {" "}
              {formatPercent(fraction)} ({formatMs(segment.ms)})
            </Text>
          </Box>
        );
      })}
      {stalled > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            {excludeStalled
              ? `Stalled: ${formatMs(stalled)} excluded — the rows above are the ${formatMs(spanMs)} this ` +
                "session spent working."
              : `Stalled: ${formatMs(stalled)} split out of Model — a call that produced almost nothing ` +
                "while the clock ran (a slept machine, a dropped stream, a failed request)."}
          </Text>
        </Box>
      ) : null}
      {corrected && corrected.reclaimedFromUserMs > 0 ? (
        <Box marginTop={1}>
          <Text color="magenta">
            Idle: {formatMs(corrected.reclaimedFromUserMs)} moved out of You — this transcript was
            resumed {corrected.phases.length === 1 ? "once" : `${corrected.phases.length} times`}, and the
            time between runs was never someone thinking.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
