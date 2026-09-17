import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseTranscript } from "../parse/parse-transcript.js";
import type { UserRecord } from "../parse/types.js";
import type { SessionListing } from "../tui/SessionPicker.js";

export type { SessionListing };

export type ResolveSessionResult =
  | { status: "found"; filePath: string; id: string }
  | { status: "ambiguous"; candidates: SessionListing[] }
  | { status: "not-found"; id: string };

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

interface CandidateFile {
  id: string;
  filePath: string;
  projectDir: string;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

async function findCandidateFiles(id: string, projectsDir: string): Promise<CandidateFile[]> {
  const files: string[] = [];
  await walk(projectsDir, files);

  const matches: CandidateFile[] = [];
  for (const filePath of files) {
    const basename = filePath.slice(filePath.lastIndexOf(sep) + 1, -".jsonl".length);
    if (!basename.startsWith(id)) {
      continue;
    }
    const rel = relative(projectsDir, filePath);
    const projectDir = rel.split(sep)[0] ?? rel;
    matches.push({ id: basename, filePath, projectDir });
  }
  return matches;
}

function isGenuineUserPrompt(record: UserRecord): boolean {
  if (record.isMeta) {
    return false;
  }
  const content = record.message?.content;
  if (content === undefined) {
    return false;
  }
  if (typeof content === "string") {
    return content.length > 0;
  }
  return content.length > 0 && content.some((block) => block.type !== "tool_result");
}

async function toListing(candidate: CandidateFile): Promise<SessionListing> {
  const [fileStat, parsed] = await Promise.all([
    stat(candidate.filePath),
    parseTranscript(candidate.filePath),
  ]);

  let cwd: string | undefined;
  let turnCount = 0;
  for (const record of parsed.records) {
    if (cwd === undefined && record.cwd !== undefined) {
      cwd = record.cwd;
    }
    if (record.type === "user" && isGenuineUserPrompt(record)) {
      turnCount++;
    }
  }

  return {
    id: candidate.id,
    filePath: candidate.filePath,
    projectDir: candidate.projectDir,
    cwd,
    date: fileStat.mtime,
    sizeBytes: fileStat.size,
    turnCount,
  };
}

/**
 * Resolves a user-supplied session id (full uuid, unique prefix, or an
 * `agent-*` name) to a transcript file. Several project dirs can hold a
 * transcript with the same id (or the same prefix); that case is surfaced
 * as "ambiguous" rather than guessed at.
 */
export async function resolveSession(
  id: string,
  projectsDir: string = defaultProjectsDir(),
): Promise<ResolveSessionResult> {
  const candidates = await findCandidateFiles(id, projectsDir);

  if (candidates.length === 0) {
    return { status: "not-found", id };
  }

  if (candidates.length === 1) {
    const [only] = candidates;
    if (!only) {
      return { status: "not-found", id };
    }
    return { status: "found", filePath: only.filePath, id: only.id };
  }

  const listings = await Promise.all(candidates.map(toListing));
  listings.sort((a, b) => a.projectDir.localeCompare(b.projectDir));
  return { status: "ambiguous", candidates: listings };
}
