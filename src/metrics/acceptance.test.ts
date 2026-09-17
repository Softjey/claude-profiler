import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEventModel } from "../model/build-model.js";
import { parseTranscript } from "../parse/parse-transcript.js";
import { computeCostStats } from "./cost.js";

// Session referenced by plan.md's T7 acceptance criteria. Only present on the
// machine that produced it, so this test skips cleanly everywhere else —
// same pattern as test/corpus.test.ts.
const SESSION_PATH = join(
  homedir(),
  ".claude",
  "projects",
  "-Users-softjey-Desktop-projects-personal-job-search-auto-applier",
  "54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8.jsonl",
);

describe("T7 acceptance criteria (session 54fd3ef0)", () => {
  const runOrSkip = existsSync(SESSION_PATH) ? it : it.skip;

  runOrSkip("reports cost.totalCostUSD from the cost-state record", async () => {
    const { records } = await parseTranscript(SESSION_PATH);
    const cost = computeCostStats(records);

    expect(cost?.totalCostUSD).toBeCloseTo(85.19, 1);
  });

  runOrSkip("reports cost as null when the transcript predates cost-state (2.1.260)", async () => {
    const { records } = await parseTranscript(SESSION_PATH);
    const preCostStateRecords = records.filter((record) => record.type !== "cost-state");

    expect(computeCostStats(preCostStateRecords)).toBeNull();
  });

  runOrSkip("builds a non-empty event model without throwing", async () => {
    const { records } = await parseTranscript(SESSION_PATH);
    const { events } = buildEventModel(records);

    expect(events.length).toBeGreaterThan(0);
  });
});
