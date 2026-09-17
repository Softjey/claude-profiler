import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import { formatMs, formatPercent } from "./format.js";

const BAR_WIDTH = 30;

interface Segment {
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
}

/**
 * The headline Model / Tools+approvals / You / unaccounted split (F2, D10),
 * always shown as percentages of the span so the four rows sum to 100%
 * regardless of rounding on any individual bar.
 */
export function TimeSplitBar({ timeline }: TimeSplitBarProps): React.JSX.Element {
  const { modelMs, toolsMs, userMs, unaccountedMs, spanMs } = timeline;

  const segments: Segment[] = [
    { label: "Model", ms: modelMs, color: "cyan" },
    { label: "Tools", ms: toolsMs, color: "yellow" },
    { label: "You", ms: userMs, color: "green" },
    { label: "Unaccounted", ms: unaccountedMs, color: "gray" },
  ];

  return (
    <Box flexDirection="column">
      {segments.map((segment) => {
        const fraction = spanMs > 0 ? segment.ms / spanMs : 0;
        return (
          <Box key={segment.label}>
            <Box width={13}>
              <Text>{segment.label}</Text>
            </Box>
            {bar(fraction, segment.color)}
            <Text>
              {" "}
              {formatPercent(fraction)} ({formatMs(segment.ms)})
            </Text>
          </Box>
        );
      })}
      {timeline.precision === "derived" ? (
        <Box marginTop={1}>
          <Text dimColor>
            Tool time includes approval waits — these are derived, not exact. Run
            `claude-profiler install-hooks` to measure exact tool execution time on future
            sessions.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
