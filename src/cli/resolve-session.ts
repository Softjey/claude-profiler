import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseTranscript } from "../parse/parse-transcript.js";
import type { UserMessage, UserRecord } from "../parse/types.js";
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

function toCandidate(filePath: string, projectsDir: string): CandidateFile {
  const basename = filePath.slice(filePath.lastIndexOf(sep) + 1, -".jsonl".length);
  const rel = relative(projectsDir, filePath);
  const projectDir = rel.split(sep)[0] ?? rel;
  return { id: basename, filePath, projectDir };
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
    matches.push(toCandidate(filePath, projectsDir));
  }
  return matches;
}

/**
 * A session id is a uuid, a prefix of one, or an `agent-<hex>` name — all
 * drawn from a narrow alphabet. A chat title (spaces, punctuation, non-Latin
 * text) can never satisfy this, which is what lets `resolveSession` tell the
 * two apart without the caller saying which one they typed.
 */
const SESSION_ID_PATTERN = /^(agent-)?[0-9a-fA-F-]+$/;

export function looksLikeSessionId(input: string): boolean {
  return SESSION_ID_PATTERN.test(input);
}

async function findFilesByContent(text: string, projectsDir: string): Promise<CandidateFile[]> {
  const files: string[] = [];
  await walk(projectsDir, files);

  const hits = await Promise.all(
    files.map(async (filePath) => {
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        return undefined;
      }
      return content.includes(text) ? filePath : undefined;
    }),
  );

  return hits
    .filter((filePath): filePath is string => filePath !== undefined)
    .map((filePath) => toCandidate(filePath, projectsDir));
}

function extractUserText(content: UserMessage["content"]): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    const text = "text" in block ? block.text : undefined;
    if (block.type === "text" && typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return undefined;
}

function cleanTitle(title: string | undefined): string | undefined {
  if (title === undefined) {
    return undefined;
  }
  const collapsed = title.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : undefined;
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
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstUserText: string | undefined;
  let firstTimestampMs: number | undefined;
  let lastTimestampMs: number | undefined;
  for (const record of parsed.records) {
    if (cwd === undefined && record.cwd !== undefined) {
      cwd = record.cwd;
    }
    if (record.type === "user" && isGenuineUserPrompt(record)) {
      turnCount++;
      if (firstUserText === undefined) {
        firstUserText = extractUserText(record.message?.content);
      }
    }
    if (record.type === "custom-title" && record.customTitle) {
      customTitle = record.customTitle;
    }
    if (record.type === "ai-title" && record.aiTitle) {
      aiTitle = record.aiTitle;
    }
    const recordMs = record.timestamp ? Date.parse(record.timestamp) : NaN;
    if (!Number.isNaN(recordMs)) {
      firstTimestampMs ??= recordMs;
      lastTimestampMs = recordMs;
    }
  }

  const durationMs =
    firstTimestampMs !== undefined && lastTimestampMs !== undefined
      ? lastTimestampMs - firstTimestampMs
      : undefined;

  return {
    id: candidate.id,
    filePath: candidate.filePath,
    projectDir: candidate.projectDir,
    cwd,
    date: fileStat.mtime,
    sizeBytes: fileStat.size,
    turnCount,
    durationMs,
    title: cleanTitle(customTitle ?? aiTitle ?? firstUserText),
  };
}

async function resolveById(id: string, projectsDir: string): Promise<ResolveSessionResult> {
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

async function resolveByTitle(title: string, projectsDir: string): Promise<ResolveSessionResult> {
  const candidates = await findFilesByContent(title, projectsDir);

  if (candidates.length === 0) {
    return { status: "not-found", id: title };
  }

  if (candidates.length === 1) {
    const [only] = candidates;
    if (!only) {
      return { status: "not-found", id: title };
    }
    return { status: "found", filePath: only.filePath, id: only.id };
  }

  const listings = await Promise.all(candidates.map(toListing));
  listings.sort((a, b) => b.date.getTime() - a.date.getTime());
  return { status: "ambiguous", candidates: listings };
}

/**
 * Resolves a user-supplied session id or chat title to a transcript file.
 *
 * The input can be a full uuid, a unique prefix, an `agent-*` name, or the
 * chat's title/first message — `looksLikeSessionId` decides which lookup to
 * run. Several project dirs can hold a transcript with the same id (or
 * title); that case is surfaced as "ambiguous" rather than guessed at.
 */
export async function resolveSession(
  input: string,
  projectsDir: string = defaultProjectsDir(),
): Promise<ResolveSessionResult> {
  return looksLikeSessionId(input) ? resolveById(input, projectsDir) : resolveByTitle(input, projectsDir);
}
