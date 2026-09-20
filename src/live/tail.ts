import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Follows an append-only JSONL file: each `read()` returns only the complete
 * lines written since the previous one. A trailing half-written line is held
 * back until its newline lands, and bytes — not strings — are buffered so a
 * multi-byte character split across two writes survives intact.
 *
 * A file that shrank was rewritten, so it is read again from the start.
 */
export class LineTail {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(readonly path: string) {}

  /** Complete new lines, or an empty array when the file is gone or unchanged. */
  read(): string[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }

    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
      }

      const lines: string[] = [];
      while (this.offset < size) {
        const length = Math.min(CHUNK_BYTES, size - this.offset);
        const chunk = Buffer.alloc(length);
        const bytesRead = readSync(fd, chunk, 0, length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.splitInto(chunk.subarray(0, bytesRead), lines);
      }
      return lines;
    } finally {
      closeSync(fd);
    }
  }

  private splitInto(chunk: Buffer, lines: string[]): void {
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    let newline = data.indexOf(0x0a);
    while (newline !== -1) {
      const line = data.subarray(0, newline).toString("utf8");
      if (line.trim().length > 0) lines.push(line);
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    this.pending = Buffer.from(data);
  }
}

/** Parses JSONL lines into plain objects, dropping anything that is not one. */
export function parseLines(lines: string[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // same leniency as parseTranscript: one bad line never aborts the read
    }
  }
  return records;
}
