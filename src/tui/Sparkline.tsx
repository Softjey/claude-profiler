import { Text } from "ink";

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Fixed regardless of `values.length`: the Context tab's acceptance
 * criterion is that a 900+-turn session renders without wrapping or tearing,
 * and the only way to guarantee that in a terminal of unknown width is to
 * never let the glyph count depend on the input size.
 */
const DEFAULT_WIDTH = 60;

/**
 * Buckets `values` down to at most `width` points by averaging each bucket,
 * so a a 900-point series still renders as one `width`-wide line instead of
 * 900 individual glyphs (which would wrap on any real terminal).
 */
function downsample(values: number[], width: number): number[] {
  if (values.length <= width) return values;
  const bucketSize = values.length / width;
  const buckets: number[] = [];
  for (let i = 0; i < width; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
    const slice = values.slice(start, end);
    buckets.push(slice.reduce((sum, v) => sum + v, 0) / slice.length);
  }
  return buckets;
}

export interface SparklineProps {
  values: number[];
  width?: number;
  color?: string;
}

export function Sparkline({ values, width = DEFAULT_WIDTH, color }: SparklineProps): React.JSX.Element {
  if (values.length === 0) {
    return <Text dimColor>(no data)</Text>;
  }

  const sampled = downsample(values, width);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  const glyphs = sampled
    .map((v) => {
      const level = range === 0 ? BLOCKS.length - 1 : Math.round(((v - min) / range) * (BLOCKS.length - 1));
      return BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, level))];
    })
    .join("");

  return <Text color={color ?? "white"}>{glyphs}</Text>;
}
