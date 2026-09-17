import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { HIGH_VOLUME_HOOK_EVENTS, PROFILER_HOOK_EVENTS, type SidecarEvent } from "./records.js";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

type HooksBlock = Record<string, unknown>;

/**
 * Events whose entries take a tool-name `matcher`. The rest are session or
 * context lifecycle events with no tool to match, where an entry carries no
 * matcher at all rather than a `"*"` that would read as meaningful.
 */
const TOOL_MATCHED_EVENTS = new Set<SidecarEvent>([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
]);

interface Settings {
  hooks?: HooksBlock;
  [key: string]: unknown;
}

/** Backup format: distinguishes "settings.json didn't exist" from "it was empty". */
interface Backup {
  existed: boolean;
  raw: string;
}

export function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function defaultBackupPath(): string {
  return join(homedir(), ".claude", "profiler", "hooks-install-backup.json");
}

export function resolveHookScriptPath(): string {
  return fileURLToPath(new URL("./hook-script.js", import.meta.url));
}

/**
 * The events an install subscribes to. `streamTiming` adds the high-volume
 * `MessageDisplay` subscription, which fires once per streaming flush rather
 * than once per turn — opt-in, because its cost scales with output length.
 */
export function eventsToInstall(streamTiming = false): readonly SidecarEvent[] {
  return streamTiming ? [...PROFILER_HOOK_EVENTS, ...HIGH_VOLUME_HOOK_EVENTS] : PROFILER_HOOK_EVENTS;
}

export function areHooksInstalled(
  settingsPath: string = defaultSettingsPath(),
  scriptPath: string = resolveHookScriptPath(),
  events: readonly SidecarEvent[] = eventsToInstall(),
): boolean {
  const { parsed } = readSettingsFile(settingsPath);
  return computeInstalledSettings(parsed, scriptPath, events).alreadyInstalled;
}

/**
 * Events this tool has registered in the given settings, whether or not they
 * match the current desired set. Lets the CLI tell "nothing installed" from
 * "an older, narrower install is present and can be upgraded".
 */
export function installedEvents(
  parsed: Settings,
  scriptPath: string = resolveHookScriptPath(),
): SidecarEvent[] {
  const hooks = (parsed.hooks ?? {}) as HooksBlock;
  const found: SidecarEvent[] = [];
  for (const event of [...PROFILER_HOOK_EVENTS, ...HIGH_VOLUME_HOOK_EVENTS]) {
    const entries = hooks[event];
    if (Array.isArray(entries) && (entries as HookEntry[]).some((e) => isProfilerEntry(e, scriptPath))) {
      found.push(event);
    }
  }
  return found;
}

function readSettingsFile(path: string): { raw: string; parsed: Settings; existed: boolean } {
  if (!existsSync(path)) return { raw: "", parsed: {}, existed: false };
  const raw = readFileSync(path, "utf8");
  const parsed = raw.trim().length > 0 ? (JSON.parse(raw) as Settings) : {};
  return { raw, parsed, existed: true };
}

function hookCommand(scriptPath: string): string {
  return `node ${JSON.stringify(scriptPath)}`;
}

function isProfilerEntry(entry: HookEntry, scriptPath: string): boolean {
  return Array.isArray(entry?.hooks) && entry.hooks.some((h) => h.command === hookCommand(scriptPath));
}

function entryFor(event: SidecarEvent, scriptPath: string): HookEntry {
  const hooks = [{ type: "command", command: hookCommand(scriptPath) }];
  return TOOL_MATCHED_EVENTS.has(event) ? { matcher: "*", hooks } : { hooks };
}

/**
 * Adds one entry per desired event, leaving every other key in `hooks` — and
 * every foreign entry inside the keys it does touch — exactly as it found them.
 * Idempotent per event: an event this tool has already registered is skipped,
 * so re-running after a version that subscribed to fewer events upgrades the
 * install in place instead of duplicating the entries that were already there.
 */
export function computeInstalledSettings(
  parsed: Settings,
  scriptPath: string,
  events: readonly SidecarEvent[] = eventsToInstall(),
): { next: Settings; alreadyInstalled: boolean; addedEvents: SidecarEvent[] } {
  const existingHooks = (parsed.hooks ?? {}) as HooksBlock;
  const nextHooks: HooksBlock = { ...existingHooks };
  const addedEvents: SidecarEvent[] = [];

  for (const event of events) {
    const raw = existingHooks[event];
    const entries: HookEntry[] = Array.isArray(raw) ? (raw as HookEntry[]) : [];
    if (entries.some((e) => isProfilerEntry(e, scriptPath))) continue;
    nextHooks[event] = [...entries, entryFor(event, scriptPath)];
    addedEvents.push(event);
  }

  if (addedEvents.length === 0) {
    return { next: parsed, alreadyInstalled: true, addedEvents };
  }

  return { next: { ...parsed, hooks: nextHooks }, alreadyInstalled: false, addedEvents };
}

/** A minimal line-based diff (LCS), good enough for a settings.json a few dozen lines long. */
export function formatDiff(beforeText: string, afterText: string): string {
  const before = beforeText.length > 0 ? beforeText.split("\n") : [];
  const after = afterText.split("\n");
  const m = before.length;
  const n = after.length;

  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push(`- ${before[i]}`);
      i++;
    } else {
      lines.push(`+ ${after[j]}`);
      j++;
    }
  }
  while (i < m) {
    lines.push(`- ${before[i]}`);
    i++;
  }
  while (j < n) {
    lines.push(`+ ${after[j]}`);
    j++;
  }

  return `${lines.join("\n")}\n`;
}

async function defaultConfirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Apply this change to ~/.claude/settings.json? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export interface InstallOptions {
  settingsPath?: string;
  backupPath?: string;
  scriptPath?: string;
  /** Adds the high-volume `MessageDisplay` subscription. */
  streamTiming?: boolean;
  confirm?: (diffText: string) => Promise<boolean> | boolean;
  stdout?: (s: string) => void;
}

export interface InstallResult {
  status: "installed" | "already-installed" | "aborted";
  message: string;
  /** Events this run added; empty when nothing needed changing. */
  addedEvents: SidecarEvent[];
}

export async function installHooks(options: InstallOptions = {}): Promise<InstallResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const backupPath = options.backupPath ?? defaultBackupPath();
  const scriptPath = options.scriptPath ?? resolveHookScriptPath();
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const confirm = options.confirm ?? defaultConfirm;
  const events = eventsToInstall(options.streamTiming ?? false);

  const { raw, parsed, existed } = readSettingsFile(settingsPath);
  const before = installedEvents(parsed, scriptPath);
  const { next, alreadyInstalled, addedEvents } = computeInstalledSettings(parsed, scriptPath, events);

  if (alreadyInstalled) {
    return {
      status: "already-installed",
      message: `claude-profiler hooks are already installed (${before.length} events).\n`,
      addedEvents: [],
    };
  }

  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const diffText = formatDiff(raw, nextText);
  stdout(diffText);

  const approved = await confirm(diffText);
  if (!approved) {
    return { status: "aborted", message: "Install aborted; settings.json left unchanged.\n", addedEvents: [] };
  }

  // Never overwrite an existing backup. A second install — upgrading a
  // narrower subscription to a wider one — would otherwise capture settings
  // that already contain this tool's own hooks, and uninstall would then
  // "restore" the user to a half-installed state instead of to the file as it
  // stood before the profiler ever touched it.
  mkdirSync(dirname(backupPath), { recursive: true });
  const upgrade = existsSync(backupPath);
  if (!upgrade) {
    const backup: Backup = { existed, raw };
    writeFileSync(backupPath, JSON.stringify(backup));
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, nextText);

  const summary = `${upgrade ? "Added" : "Installed"} ${addedEvents.length} hook event${
    addedEvents.length === 1 ? "" : "s"
  } in ${settingsPath}\n  ${addedEvents.join(", ")}\n`;
  const backupNote = upgrade
    ? `Pre-existing backup at ${backupPath} left untouched, so uninstall still restores your original settings.\n`
    : `Original backed up to ${backupPath}\n`;

  return { status: "installed", message: summary + backupNote, addedEvents };
}
