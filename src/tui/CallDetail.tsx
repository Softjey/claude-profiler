import { Box, Text } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { formatDateTime, formatMs } from "./format.js";

export interface CallDetailScreenProps extends ScreenProps {
  call: ToolCall;
  tool: ExactToolStat;
}

/**
 * Why a call was (or wasn't) flagged an outlier, spelling out T5's isOutlier
 * rule (tool-stats.ts) instead of leaving the `!` marker unexplained one
 * level in.
 */
function outlierReason(call: ToolCall, medianMs: number): string | null {
  if (!call.isOutlier || call.durationMs === null) return null;
  const floor = Math.max(medianMs * 5, 30_000);
  return `${formatMs(call.durationMs)} exceeds max(5× median ${formatMs(medianMs)}, 30s) = ${formatMs(floor)}`;
}

/**
 * The full-detail pane for one call (F2 step 3): whatever the artifact kept
 * of the tool input, plus turn/time/duration and, when flagged, why.
 */
export function CallDetailScreen({ call, tool }: CallDetailScreenProps): React.JSX.Element {
  const reason = outlierReason(call, tool.medianMs);

  return (
    <Box flexDirection="column">
      <Text bold>
        {tool.name} · call {call.id}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Turn: {call.turnIndex}</Text>
        <Text>Started: {formatDateTime(call.startedAt)}</Text>
        <Text>
          Duration: {call.durationMs === null ? "unfinished (no matching tool_result, FR10)" : formatMs(call.durationMs)}
        </Text>
        <Text color={call.isOutlier ? "red" : "white"}>Outlier: {call.isOutlier ? `yes — ${reason}` : "no"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Input</Text>
        <Text wrap="wrap">{call.inputPreview}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}

export function callDetailScreen(call: ToolCall, tool: ExactToolStat): NavScreen {
  return {
    id: `call:${call.id}`,
    render: (props) => <CallDetailScreen {...props} call={call} tool={tool} />,
  };
}
