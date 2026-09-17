import { Box, Text } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { formatDateTime, formatMs } from "./format.js";

export interface CallDetailScreenProps extends ScreenProps {
  call: ToolCall;
  tool: ExactToolStat;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isComposite(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null;
}

function JsonScalar({ value }: { value: JsonPrimitive }): React.JSX.Element {
  if (value === null) return <Text dimColor>null</Text>;
  if (typeof value === "string") return <Text color="green">"{value}"</Text>;
  if (typeof value === "boolean") return <Text color="yellow">{String(value)}</Text>;
  return <Text color="magenta">{value}</Text>;
}

/**
 * One line of the pretty-printed tree (F2 follow-up): a key/index plus
 * either an inline scalar or, for an object/array, its own indented block of
 * child entries. Recurses instead of going through JSON.stringify so keys,
 * strings, and punctuation can each get their own color.
 */
function JsonEntry({
  label,
  value,
  depth,
}: {
  label: string | undefined;
  value: JsonValue;
  depth: number;
}): React.JSX.Element {
  const indent = "  ".repeat(depth);
  if (!isComposite(value)) {
    return (
      <Box>
        <Text>{indent}</Text>
        {label !== undefined ? (
          <Text color="cyan">
            {label}
            <Text dimColor>: </Text>
          </Text>
        ) : (
          <Text dimColor>- </Text>
        )}
        <JsonScalar value={value} />
      </Box>
    );
  }

  const entries: [string | undefined, JsonValue][] = Array.isArray(value)
    ? value.map((v) => [undefined, v])
    : Object.entries(value);

  if (entries.length === 0) {
    return (
      <Box>
        <Text>{indent}</Text>
        {label !== undefined ? (
          <Text color="cyan">
            {label}
            <Text dimColor>: </Text>
          </Text>
        ) : null}
        <Text dimColor>{Array.isArray(value) ? "[]" : "{}"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {label !== undefined ? (
        <Box>
          <Text>{indent}</Text>
          <Text color="cyan">{label}</Text>
          <Text dimColor>:</Text>
        </Box>
      ) : null}
      {entries.map(([key, v], i) => (
        // eslint-disable-next-line react/no-array-index-key -- entries have no stable id
        <JsonEntry key={key ?? i} label={key} value={v} depth={depth + 1} />
      ))}
    </Box>
  );
}

/**
 * inputPreview is minified JSON, truncated at INPUT_PREVIEW_MAX_CHARS at the
 * source (tool-stats.ts) — still possible to land mid-token on a very large
 * input, so JSON.parse can fail. Render a colored tree only when the preview
 * happens to be a complete JSON object/array; a bare string (or truncated
 * JSON) falls back to the raw text as-is.
 */
function CallInput({ inputPreview }: { inputPreview: string }): React.JSX.Element {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputPreview);
  } catch {
    return <Text wrap="wrap">{inputPreview}</Text>;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return <Text wrap="wrap">{inputPreview}</Text>;
  }
  return <JsonEntry label={undefined} value={parsed as JsonValue} depth={0} />;
}

/**
 * The full-detail pane for one call (F2 step 3): whatever the artifact kept
 * of the tool input, plus turn/time/duration.
 */
export function CallDetailScreen({ call, tool }: CallDetailScreenProps): React.JSX.Element {
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
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Input</Text>
        <CallInput inputPreview={call.inputPreview} />
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
