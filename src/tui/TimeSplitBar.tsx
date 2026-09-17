import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import { formatMs, formatPercent } from "./format.js";

const BAR_WIDTH = 30;

export const CATEGORY_KEYS = ["model", "tools", "you", "unaccounted"] as const;
export type Category = (typeof CATEGORY_KEYS)[number];

interface Segment {
  key: Category;
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
}

/**
 * The headline Model / Tools+approvals / You / unaccounted split (F2, D10),
 * always shown as percentages of the span so the four rows sum to 100%
 * regardless of rounding on any individual bar. Each row is drillable: the
 * caller renders a breakdown table for whichever `activeCategory` it tracks.
 */
export function TimeSplitBar({ timeline, activeCategory }: TimeSplitBarProps): React.JSX.Element {
  const { modelMs, toolsMs, userMs, unaccountedMs, spanMs } = timeline;

  const segments: Segment[] = [
    { key: "model", label: "Model", ms: modelMs, color: "cyan" },
    { key: "tools", label: "Tools", ms: toolsMs, color: "yellow" },
    { key: "you", label: "You", ms: userMs, color: "green" },
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
    </Box>
  );
}
