import { Box, Text } from "ink";
import type { ContextPoint } from "../metrics/context.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { formatCount, formatDateTime } from "./format.js";

export interface PromptPointDetailScreenProps extends ScreenProps {
  point: ContextPoint;
}

/** The full-detail pane for one assistant message's context point, one level deeper than Timeline's turn detail list. */
export function PromptPointDetailScreen({ point }: PromptPointDetailScreenProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Turn {point.turnIndex} · assistant message</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>At: {point.at === null ? "—" : formatDateTime(point.at)}</Text>
        <Text>Cache read tokens: {formatCount(point.cacheReadTokens)}</Text>
        <Text>Cache create tokens: {formatCount(point.cacheCreateTokens)}</Text>
        <Text>Output tokens: {formatCount(point.outputTokens)}</Text>
        <Text>Thinking tokens: {formatCount(point.thinkingTokens)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}

export function promptPointDetailScreen(point: ContextPoint): NavScreen {
  return {
    id: `context-point:${point.turnIndex}:${point.at ?? "?"}`,
    render: (props) => <PromptPointDetailScreen {...props} point={point} />,
  };
}
