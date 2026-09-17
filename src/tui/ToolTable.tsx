import { Box, Text } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import { formatMs, formatPercent } from "./format.js";

const VISIBLE_ROWS = 15;

export type SortKey = "totalMs" | "calls" | "medianMs" | "name";

export const SORT_KEYS: SortKey[] = ["totalMs", "calls", "medianMs", "name"];

const SORT_LABELS: Record<SortKey, string> = {
  totalMs: "total",
  calls: "calls",
  medianMs: "median",
  name: "name",
};

/**
 * A row diverges enough from its own typical cost that one glance should
 * flag it (T13 step 4): the raw sum is more than 3x what `calls * median`
 * predicts, meaning a handful of outliers — not the tool itself — are
 * driving the total.
 */
export function isOutlierDominated(tool: ExactToolStat): boolean {
  return tool.typicalMs > 0 && tool.totalMs > tool.typicalMs * 3;
}

export function sortTools(tools: ExactToolStat[], sortKey: SortKey, filter: string): ExactToolStat[] {
  const filtered = filter
    ? tools.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()))
    : tools;

  const sorted = [...filtered];
  switch (sortKey) {
    case "totalMs":
      sorted.sort((a, b) => b.totalMs - a.totalMs);
      break;
    case "calls":
      sorted.sort((a, b) => b.calls - a.calls);
      break;
    case "medianMs":
      sorted.sort((a, b) => b.medianMs - a.medianMs);
      break;
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return sorted;
}

export interface ToolTableProps {
  tools: ExactToolStat[];
  selectedIndex: number;
  sortKey: SortKey;
  filter: string;
}

export function ToolTable({ tools, selectedIndex, sortKey, filter }: ToolTableProps): React.JSX.Element {
  const rows = sortTools(tools, sortKey, filter);
  // Same windowing as Timeline.tsx's TimelineScreen (see ToolDetail.tsx's
  // identical comment): without it a session with more tools than fit on
  // screen just prints every row and leaves the highlighted one to the
  // terminal's own scrollback.
  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, rows.length - VISIBLE_ROWS),
  );
  const visibleRows = rows.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          sorted by {SORT_LABELS[sortKey]} · {rows.length} tool{rows.length === 1 ? "" : "s"}
          {filter ? ` · filter "${filter}"` : ""}
        </Text>
      </Box>
      <Box>
        <Box width={34} marginRight={1} flexShrink={0}>
          <Text bold>Tool</Text>
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
        <Box width={9} flexShrink={0}>
          <Text bold>Outliers</Text>
        </Box>
      </Box>
      {rows.length === 0 ? (
        <Text dimColor>No tool calls match.</Text>
      ) : (
        visibleRows.map((tool, i) => {
          const selected = windowStart + i === selectedIndex;
          const outlier = isOutlierDominated(tool);
          const color = selected ? "cyan" : "white";
          const marker = outlier ? "!" : selected ? ">" : " ";
          return (
            <Box key={tool.name}>
              <Box width={34} marginRight={1} flexShrink={0}>
                <Text color={outlier ? "red" : color} bold={outlier} wrap="truncate-end">
                  {marker} {tool.name}
                </Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color={color}>{formatMs(tool.totalMs)}</Text>
              </Box>
              <Box width={8} flexShrink={0}>
                <Text color={color}>{formatPercent(tool.pctOfSession)}</Text>
              </Box>
              <Box width={7} flexShrink={0}>
                <Text color={color}>{tool.calls}</Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color={color}>{formatMs(tool.medianMs)}</Text>
              </Box>
              <Box width={9} flexShrink={0}>
                <Text color={color}>{tool.outlierCount > 0 ? tool.outlierCount : "—"}</Text>
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}
