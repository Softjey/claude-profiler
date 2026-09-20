import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One running Claude Code process, as Claude Code itself advertises it in
 * `~/.claude/sessions/<pid>.json`. The file is internal and undocumented, so
 * every field but `pid` and `sessionId` is optional and a file that does not
 * parse is skipped rather than failing the whole read.
 */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | undefined;
  entrypoint: string | undefined;
  status: string | undefined;
  name: string | undefined;
  startedAt: number | undefined;
}

export function defaultRegistryDir(): string {
  return join(homedir(), ".claude", "sessions");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseRegistryEntry(text: string): RegistryEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;

  const pid = num(raw.pid);
  const sessionId = str(raw.sessionId);
  if (pid === undefined || sessionId === undefined) return null;

  return {
    pid,
    sessionId,
    cwd: str(raw.cwd),
    entrypoint: str(raw.entrypoint),
    status: str(raw.status),
    name: str(raw.name),
    startedAt: num(raw.startedAt),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Registry files outlive a crashed process, so an entry only counts while its
 * pid still answers. `alive` is injectable for tests.
 */
export function readRegistry(
  dir: string = defaultRegistryDir(),
  alive: (pid: number) => boolean = isAlive,
): RegistryEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const entry = parseRegistryEntry(text);
    if (entry && alive(entry.pid)) entries.push(entry);
  }
  return entries;
}
