import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEventModel } from "../src/model/build-model.js";
import { computeTimeSplit } from "../src/metrics/time-split.js";
import { parseTranscript } from "../src/parse/parse-transcript.js";
import type { TranscriptRecord } from "../src/parse/types.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

async function findTranscripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

function versionOf(record: TranscriptRecord): string | undefined {
  return (record as { version?: unknown }).version as string | undefined;
}

describe("corpus smoke test", () => {
  const hasProjectsDir = existsSync(PROJECTS_DIR);
  const runOrSkip = hasProjectsDir ? it : it.skip;

  runOrSkip(
    "parses every local transcript without throwing",
    async () => {
      const files = await findTranscripts(PROJECTS_DIR);
      expect(files.length).toBeGreaterThan(0);

      let totalRecords = 0;
      let totalSkippedLines = 0;
      const versions = new Set<string>();
      const recordTypes = new Set<string>();

      for (const file of files) {
        // Every file must parse without throwing — that is the whole point of this test.
        const { records, diagnostics } = await parseTranscript(file);

        totalRecords += records.length;
        totalSkippedLines += diagnostics.skippedLines;

        for (const record of records) {
          recordTypes.add(record.type);
          const version = versionOf(record);
          if (version) {
            versions.add(version);
          }
        }

        // ---- T5's time-split invariant ----
        const { events, toolUses } = buildEventModel(records);
        const split = computeTimeSplit(events, toolUses);
        expect(split.modelMs + split.toolsMs + split.userMs + split.unaccountedMs).toBe(
          split.spanMs,
        );
        expect(split.unaccountedMs).toBeGreaterThanOrEqual(0);
      }

      const sortedVersions = [...versions].sort();
      console.log(
        [
          "corpus smoke test summary:",
          `  files:            ${files.length}`,
          `  total records:    ${totalRecords}`,
          `  skipped lines:    ${totalSkippedLines}`,
          `  distinct versions: ${sortedVersions.length}`,
          `  versions:         ${sortedVersions.join(", ")}`,
          `  record types:     ${[...recordTypes].sort().join(", ")}`,
        ].join("\n"),
      );

      // Acceptance criterion: the summary reports at least the range 2.1.219-2.1.273.
      expect(versions.has("2.1.219")).toBe(true);
      expect(versions.has("2.1.273")).toBe(true);
    },
    120_000,
  );

  if (!hasProjectsDir) {
    it("skips cleanly when ~/.claude/projects is absent", () => {
      console.log(`corpus smoke test: no ${PROJECTS_DIR}, skipping`);
      expect(hasProjectsDir).toBe(false);
    });
  }
});
