import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { KNOWN_RECORD_TYPES, type ParseResult, type TranscriptRecord } from "./types.js";

const KNOWN_TYPE_SET = new Set<string>(KNOWN_RECORD_TYPES);

/**
 * Streams a transcript file line by line, never loading it whole.
 * A malformed line or an unknown record type never aborts the run; both are
 * counted in `diagnostics` instead. Only a stream-level failure (e.g. the
 * file does not exist or is unreadable) rejects.
 */
export async function parseTranscript(filePath: string): Promise<ParseResult> {
  const records: TranscriptRecord[] = [];
  const diagnostics: ParseResult["diagnostics"] = {
    skippedLines: 0,
    unknownRecordTypes: {},
  };

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.skippedLines++;
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      diagnostics.skippedLines++;
      continue;
    }

    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string") {
      diagnostics.skippedLines++;
      continue;
    }

    if (!KNOWN_TYPE_SET.has(type)) {
      diagnostics.unknownRecordTypes[type] = (diagnostics.unknownRecordTypes[type] ?? 0) + 1;
      continue;
    }

    records.push(parsed as TranscriptRecord);
  }

  return { records, diagnostics };
}
