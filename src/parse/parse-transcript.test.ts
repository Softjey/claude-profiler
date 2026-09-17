import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTranscript } from "./parse-transcript.js";

describe("parseTranscript", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-profiler-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it("parses known record types into typed records", async () => {
    const path = fixture(
      "basic.jsonl",
      [
        JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:01.000Z" }),
      ].join("\n") + "\n",
    );

    const { records, diagnostics } = await parseTranscript(path);

    expect(records).toHaveLength(2);
    expect(records[0]?.type).toBe("user");
    expect(records[1]?.type).toBe("assistant");
    expect(diagnostics.skippedLines).toBe(0);
    expect(diagnostics.unknownRecordTypes).toEqual({});
  });

  it("skips blank lines without counting them", async () => {
    const path = fixture(
      "blank-lines.jsonl",
      `${JSON.stringify({ type: "system" })}\n\n\n${JSON.stringify({ type: "mode" })}\n`,
    );

    const { records, diagnostics } = await parseTranscript(path);

    expect(records).toHaveLength(2);
    expect(diagnostics.skippedLines).toBe(0);
  });

  it("reports skippedLines: 1 for a truncated final line", async () => {
    const path = fixture(
      "truncated.jsonl",
      `${JSON.stringify({ type: "system", content: "ok" })}\n{"type": "user", "content": "cut off`,
    );

    const { records, diagnostics } = await parseTranscript(path);

    expect(records).toHaveLength(1);
    expect(diagnostics.skippedLines).toBe(1);
  });

  it("counts an invented type in unknownRecordTypes without throwing", async () => {
    const path = fixture(
      "unknown-type.jsonl",
      [
        JSON.stringify({ type: "totally-made-up" }),
        JSON.stringify({ type: "totally-made-up" }),
        JSON.stringify({ type: "system" }),
      ].join("\n") + "\n",
    );

    const { records, diagnostics } = await parseTranscript(path);

    expect(records).toHaveLength(1);
    expect(diagnostics.unknownRecordTypes).toEqual({ "totally-made-up": 2 });
  });

  it("skips a record with no type field instead of throwing", async () => {
    const path = fixture(
      "no-type.jsonl",
      [JSON.stringify({ foo: "bar" }), JSON.stringify({ type: "system" })].join("\n") + "\n",
    );

    const { records, diagnostics } = await parseTranscript(path);

    expect(records).toHaveLength(1);
    expect(diagnostics.skippedLines).toBe(1);
  });

  it("rejects for a file that does not exist", async () => {
    await expect(parseTranscript(join(dir, "does-not-exist.jsonl"))).rejects.toThrow();
  });
});
