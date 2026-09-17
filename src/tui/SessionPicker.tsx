import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";

export interface SessionListing {
  id: string;
  filePath: string;
  projectDir: string;
  cwd: string | undefined;
  date: Date;
  sizeBytes: number;
  turnCount: number;
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

  return (
    <Box flexDirection="column">
      <Text>Several sessions match — pick one:</Text>
      <Box flexDirection="column" marginTop={1}>
        {candidates.map((candidate, i) => {
          const row = (
            <>
              {i === index ? "> " : "  "}
              {candidate.cwd ?? "(unknown cwd)"} [{candidate.projectDir}] — {formatDate(candidate.date)} —{" "}
              {formatSize(candidate.sizeBytes)} — {candidate.turnCount} turns
            </>
          );
          return i === index ? (
            <Text key={candidate.filePath} color="cyan">
              {row}
            </Text>
          ) : (
            <Text key={candidate.filePath}>{row}</Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ⏎ open · Esc quit</Text>
      </Box>
    </Box>
  );
}
