import { Box, Text } from "ink";
import type { UserGap } from "../metrics/time-split.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { formatMs } from "./format.js";

export interface PromptDetailScreenProps extends ScreenProps {
  gap: UserGap;
  index: number;
  total: number;
}

/**
 * One prompt's own drill-down (D-follow-up to the You list): the full prompt
 * text — up to `PROMPT_PREVIEW_MAX_CHARS`, the most the model ever retains,
 * see build-model.ts — instead of the list's 50-char single-line cut, plus
 * how long it took to write.
 */
export function PromptDetailScreen({ gap, index, total }: PromptDetailScreenProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>
        Prompt {index + 1} of {total}
      </Text>
      <Box marginTop={1}>
        <Text>{gap.preview}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Took </Text>
        <Text bold>{formatMs(gap.gapMs)}</Text>
        <Text dimColor> to write, since the previous reply ended.</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}

export function promptDetailScreen(gap: UserGap, index: number, total: number): NavScreen {
  return {
    id: `prompt:${index}`,
    render: (props) => <PromptDetailScreen {...props} gap={gap} index={index} total={total} />,
  };
}
