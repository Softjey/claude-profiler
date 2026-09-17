import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { PhaseSplit } from "../metrics/session-phases.js";
import { formatMs, formatPercent } from "./format.js";

const BAR_WIDTH = 30;

export const CATEGORY_KEYS = ["model", "tools", "you", "unaccounted"] as const;
export type Category = (typeof CATEGORY_KEYS)[number];

/**
 * `idle` is deliberately outside `Category`: it is not drillable, because
 * there is nothing underneath it but "the session was closed". Keeping it out
 * also leaves the ←→ category cycle exactly four stops long.
 */
type SegmentKey = Category | "idle";

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
}

/**
 * The headline Model / Tools+approvals / You / unaccounted split (F2, D10),
 * always shown as percentages of the span so the rows sum to 100% regardless
 * of rounding on any individual bar. Each row but Idle is drillable: the
 * caller renders a breakdown table for whichever `activeCategory` it tracks.
 */
export function TimeSplitBar({ timeline, activeCategory, phases }: TimeSplitBarProps): React.JSX.Element {
  const { modelMs, toolsMs, spanMs } = timeline;
  const corrected = phases ?? null;
  const userMs = corrected ? corrected.userMs : timeline.userMs;
  const unaccountedMs = corrected ? corrected.unaccountedMs : timeline.unaccountedMs;

  const segments: Segment[] = [
    { key: "model", label: "Model", ms: modelMs, color: "cyan" },
    { key: "tools", label: "Tools", ms: toolsMs, color: "yellow" },
    { key: "you", label: "You", ms: userMs, color: "green" },
    ...(corrected ? [{ key: "idle" as const, label: "Idle", ms: corrected.idleMs, color: "magenta" }] : []),
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
