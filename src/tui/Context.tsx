import { Box, Text } from "ink";
import { registerTab, type ScreenProps } from "./shell.js";
import { Sparkline } from "./Sparkline.js";
import { formatCount, formatDateTime } from "./format.js";

function Series({
  title,
  values,
  color,
  annotateMinMax,
}: {
  title: string;
  values: number[];
  color: string;
  annotateMinMax: boolean;
}): React.JSX.Element {
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const final = values.length > 0 ? values[values.length - 1] : 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      <Sparkline values={values} color={color} />
      <Text dimColor>
        {annotateMinMax
          ? `min ${formatCount(min)} · max ${formatCount(max)} · final ${formatCount(final ?? 0)}`
          : `final ${formatCount(final ?? 0)}`}
      </Text>
    </Box>
  );
}

/**
 * The context-growth chart (FR17, T15 step 2): how much prior context is
 * being re-billed via cache_read as the session goes on, plus output and
 * thinking tokens per assistant turn — one point per assistant message
 * (`profile.context.turns`, T7's series), not per user turn, so a long
 * session's point count can run into the thousands. `Sparkline` downsamples
 * to a fixed width regardless, which is what keeps this screen from
 * wrapping or tearing on a 900+-turn session (T15's acceptance criterion).
 */
export function ContextScreen({ profile }: ScreenProps): React.JSX.Element {
  const points = profile.context.turns;
  const cacheReadTokens = points.map((p) => p.cacheReadTokens);
  const outputTokens = points.map((p) => p.outputTokens);
  const thinkingTokens = points.map((p) => p.thinkingTokens);
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <Box flexDirection="column">
      <Text bold>Context growth</Text>
      <Text dimColor>
        {points.length} assistant turn{points.length === 1 ? "" : "s"}
        {first && last ? ` · ${formatDateTime(first.at)} → ${formatDateTime(last.at)}` : ""}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Series title="Cache read tokens" values={cacheReadTokens} color="cyan" annotateMinMax />
        <Series title="Output tokens" values={outputTokens} color="green" annotateMinMax={false} />
        <Series title="Thinking tokens" values={thinkingTokens} color="magenta" annotateMinMax={false} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>⇥ next tab · q quit</Text>
      </Box>
    </Box>
  );
}

registerTab({ id: "context", title: "Context", render: (props) => <ContextScreen {...props} /> });
