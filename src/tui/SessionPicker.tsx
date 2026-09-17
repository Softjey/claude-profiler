import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";

const VISIBLE_ROWS = 15;

export interface SessionListing {
  id: string;
  filePath: string;
  projectDir: string;
  cwd: string | undefined;
  date: Date;
  sizeBytes: number;
  turnCount: number;
  title: string | undefined;
}

export interface SessionPickerProps {
  candidates: SessionListing[];
  onSelect: (candidate: SessionListing) => void;
  onCancel: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

const PATH_WIDTH = 32;
const TITLE_WIDTH = 36;
const DATE_WIDTH = 16;
const SIZE_WIDTH = 6;
const TURNS_WIDTH = 5;

interface Column {
  header: string;
  width: number;
  value: (candidate: SessionListing) => string;
}

const COLUMNS: Column[] = [
  { header: "Path", width: PATH_WIDTH, value: (c) => c.cwd ?? "(unknown)" },
  { header: "Title", width: TITLE_WIDTH, value: (c) => c.title ?? "(no title)" },
  { header: "Date", width: DATE_WIDTH, value: (c) => formatDate(c.date) },
  { header: "Size", width: SIZE_WIDTH, value: (c) => formatSize(c.sizeBytes) },
  { header: "Turns", width: TURNS_WIDTH, value: (c) => String(c.turnCount) },
];

function Row({
  cells,
  selected,
  bold = false,
}: {
  cells: string[];
  selected: boolean;
  bold?: boolean;
}): React.JSX.Element {
  const color = selected ? "cyan" : undefined;
  return (
    <Box>
      <Text {...(color ? { color } : {})} bold={bold}>
        {selected ? "> " : "  "}
      </Text>
      {COLUMNS.map((col, i) => (
        <Box key={col.header} width={col.width} marginRight={2}>
          <Text {...(color ? { color } : {})} bold={bold} wrap="truncate-end">
            {cells[i]}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function SessionPicker({ candidates, onSelect, onCancel }: SessionPickerProps): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i - 1 + candidates.length) % candidates.length);
    } else if (key.downArrow) {
      setIndex((i) => (i + 1) % candidates.length);
    } else if (key.return) {
      const chosen = candidates[index];
      if (chosen) {
        onSelect(chosen);
        exit();
      }
    } else if (key.escape || input === "q") {
      onCancel();
      exit();
    }
  });

  // Same windowing as Timeline.tsx's TimelineScreen: keeps the highlighted
  // session on screen instead of leaving that to the terminal's own
  // scrollback once there are more candidates than fit.
  const windowStart = Math.min(
    Math.max(0, index - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, candidates.length - VISIBLE_ROWS),
  );
  const visibleCandidates = candidates.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Text>Several sessions match — pick one:</Text>
      <Box flexDirection="column" marginTop={1}>
        <Row cells={COLUMNS.map((col) => col.header)} selected={false} bold />
        {visibleCandidates.map((candidate, i) => (
          <Row
            key={candidate.filePath}
            cells={COLUMNS.map((col) => col.value(candidate))}
            selected={windowStart + i === index}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ⏎ open · Esc quit</Text>
      </Box>
    </Box>
  );
}
