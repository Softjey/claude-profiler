import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isSea } from "node:sea";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  HIGH_VOLUME_HOOK_EVENTS,
  PROFILER_HOOK_EVENTS,
  RETIRED_HOOK_EVENTS,
  type SidecarEvent,
} from "./records.js";

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface HookCommand {
  type: string;
  command: string;
  async?: boolean;
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

/**
 * Events whose hook stays synchronous. Everything else runs with `async: true`:
 * the script only appends a line and never answers CC, so there is nothing to
 * wait for, and waiting cost ~50ms per event — twice per tool call. These three
 * fire at most once per turn and sit right before teardown, where `claude -p`
 * kills any async hook still running; a sync hook there costs little and keeps
 * the record.
 */
const SYNC_EVENTS = new Set<SidecarEvent>(["Stop", "StopFailure", "SessionEnd"]);

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

/**
 * Where the hook script is deployed and what settings.json points at. A path
 * outside the package on purpose: a package run through `npx` lives in a cache
 * that is evicted and renamed on every new version, and a global install moves
 * with the Node version, so a hook pointing into either breaks without notice.
 */
export function defaultHookDir(): string {
  return join(homedir(), ".claude", "profiler", "hooks");
}

export function resolveHookScriptPath(hookDir: string = defaultHookDir()): string {
  return join(hookDir, "hook-script.js");
}

/**
 * What settings.json runs for each hook event: the deployed script, under
 * `node`, when this is the npm package; this very executable when it is the
 * standalone build, which carries its own Node and needs none installed.
 */
export function defaultHookTarget(): string {
  return isSea() ? stableExecutablePath(process.execPath) : resolveHookScriptPath();
}

/**
 * `execPath` as a path that survives an upgrade. Homebrew runs a formula from
 * a versioned keg — `<prefix>/Cellar/<name>/<version>/bin/…` — that the next
 * `brew upgrade` deletes; its `<prefix>/opt/<name>` link always points at the
 * current one. Any other location is where the user put the binary, and an
 * upgrade replaces it in place.
 */
export function stableExecutablePath(execPath: string, exists: (path: string) => boolean = existsSync): string {
  let real = execPath;
  try {
    real = realpathSync(execPath);
  } catch {
    // Keep the path as given.
  }
  const keg = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/](.+)$/.exec(real);
  const [, prefix, name, rest] = keg ?? [];
  if (prefix !== undefined && name !== undefined && rest !== undefined) {
    const opt = join(prefix, "opt", name, rest);
    if (exists(opt)) return opt;
  }
  return real;
}

/** Whether `target` is the hook script, run under `node`, rather than an executable run with `hook`. */
function isScriptTarget(target: string): boolean {
  return target.endsWith(".js");
}

/** The compiled hook files shipped with this package, next to this module. */
export function bundledHookDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Everything hook-script.js needs at runtime. It must stay self-contained:
 * install.test.ts fails if it grows an import of a module not listed here.
 */
export const HOOK_FILES = ["hook-script.js", "records.js"] as const;

/**
 * Copies the hook files into `hookDir`, overwriting an older copy so a
 * re-install after an upgrade also refreshes the script. The `package.json`
 * marks the copies as ES modules, which a bare directory would not.
 */
export function deployHookScript(hookDir: string = defaultHookDir(), sourceDir: string = bundledHookDir()): void {
  mkdirSync(hookDir, { recursive: true });
  for (const file of HOOK_FILES) copyFileSync(join(sourceDir, file), join(hookDir, file));
  writeFileSync(join(hookDir, "package.json"), '{ "type": "module" }\n');
}

/**
 * The events an install subscribes to. `streamTiming` adds the high-volume
 * `MessageDisplay` subscription, which fires once per streaming flush rather
 * than once per turn — opt-in, because its cost scales with output length.
 */
export function eventsToInstall(streamTiming = false): readonly SidecarEvent[] {
  return streamTiming ? [...PROFILER_HOOK_EVENTS, ...HIGH_VOLUME_HOOK_EVENTS] : PROFILER_HOOK_EVENTS;
}

/**
 * Whether every event is subscribed at all. An install from an older release —
 * synchronous entries, retired events — still counts: it measures sessions
 * fine, and `install-hooks` upgrades it in place.
 */
export function areHooksInstalled(
  settingsPath: string = defaultSettingsPath(),
  target: string = defaultHookTarget(),
  events: readonly SidecarEvent[] = eventsToInstall(),
): boolean {
  const { parsed } = readSettingsFile(settingsPath);
  const present = new Set(installedEvents(parsed, target));
  return events.every((event) => present.has(event));
}

/**
 * Events this tool has registered in the given settings, whether or not they
 * match the current desired set. Lets the CLI tell "nothing installed" from
 * "an older, narrower install is present and can be upgraded".
 */
export function installedEvents(
  parsed: Settings,
  target: string = defaultHookTarget(),
): SidecarEvent[] {
  const hooks = (parsed.hooks ?? {}) as HooksBlock;
  const found: SidecarEvent[] = [];
  for (const event of [...PROFILER_HOOK_EVENTS, ...HIGH_VOLUME_HOOK_EVENTS]) {
    const entries = hooks[event];
    if (Array.isArray(entries) && (entries as HookEntry[]).some((e) => isProfilerEntry(e, target))) {
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

function hookCommand(target: string): string {
  return isScriptTarget(target) ? `node ${JSON.stringify(target)}` : `${JSON.stringify(target)} hook`;
}

/**
 * Releases before the deployed copy pointed settings.json straight into the
 * package — an npx cache, a global install, a checkout. Those commands are
 * still ours, so an install rewrites them to the deployed path instead of
 * adding a second entry beside them.
 */
const LEGACY_COMMAND = /^node ".*claude-profiler[\\/]+dist[\\/]+hooks[\\/]+hook-script\.js"$/;

/** The standalone build, wherever it was installed; `cprof` is the name its symlink goes by. */
const BINARY_COMMAND = /^"[^"]*[\\/](?:claude-profiler|cprof)" hook$/;

/**
 * Ours in any of its forms, not only the one this run would write: switching
 * between the npm package and the standalone build rewrites the entries the
 * other one left instead of adding a second set beside them.
 */
function isProfilerCommand(command: string, target: string): boolean {
  return (
    command === hookCommand(target) ||
    command === hookCommand(resolveHookScriptPath()) ||
    LEGACY_COMMAND.test(command) ||
    BINARY_COMMAND.test(command)
  );
}

function isProfilerEntry(entry: HookEntry, target: string): boolean {
  return Array.isArray(entry?.hooks) && entry.hooks.some((h) => isProfilerCommand(h.command, target));
}

function commandFor(event: SidecarEvent, target: string): HookCommand {
  const command: HookCommand = { type: "command", command: hookCommand(target) };
  if (!SYNC_EVENTS.has(event)) command.async = true;
  return command;
}

function entryFor(event: SidecarEvent, target: string): HookEntry {
  const hooks = [commandFor(event, target)];
  return TOOL_MATCHED_EVENTS.has(event) ? { matcher: "*", hooks } : { hooks };
}

/**
 * An event's entries with our commands rewritten to the current shape and
 * path, and all but the first of them dropped — a legacy entry next to a
 * current one would otherwise record every event twice. Foreign commands are
 * untouched; an entry left with no command at all goes.
 */
function upgradeEntries(entries: HookEntry[], event: SidecarEvent, target: string): HookEntry[] {
  const desired = commandFor(event, target);
  let kept = false;
  const upgraded: HookEntry[] = [];
  for (const entry of entries) {
    if (!isProfilerEntry(entry, target)) {
      upgraded.push(entry);
      continue;
    }
    const hooks: HookCommand[] = [];
    for (const h of entry.hooks) {
      if (!isProfilerCommand(h.command, target)) {
        hooks.push(h);
      } else if (!kept) {
        const { async: _previous, ...rest } = h;
        hooks.push({ ...rest, ...desired });
        kept = true;
      }
    }
    if (hooks.length > 0) upgraded.push({ ...entry, hooks });
  }
  return upgraded;
}

function areCurrentEntries(entries: HookEntry[], event: SidecarEvent, target: string): boolean {
  const desired = commandFor(event, target);
  const ours = entries.flatMap((e) => e.hooks.filter((h) => isProfilerCommand(h.command, target)));
  return ours.length === 1 && ours[0]!.command === desired.command && ours[0]!.async === desired.async;
}

/**
 * Brings the profiler's entries to the desired set, leaving every other key in
 * `hooks` — and every foreign entry inside the keys it does touch — exactly as
 * it found them. Idempotent per event, and an upgrade path for older installs:
 *
 * - a desired event with no profiler entry gets one (`addedEvents`);
 * - a profiler entry in an outdated shape — say, synchronous — is rewritten in
 *   place (`updatedEvents`);
 * - a profiler entry on a retired event is removed, and the event key with it
 *   when nothing else was registered there (`removedEvents`).
 *
 * An event outside the desired set that is not retired — `MessageDisplay` from
 * an earlier `--stream-timing` install — is upgraded but never dropped: leaving
 * a flag off a later run is not asking to lose it.
 */
export function computeInstalledSettings(
  parsed: Settings,
  target: string,
  events: readonly SidecarEvent[] = eventsToInstall(),
): {
  next: Settings;
  alreadyInstalled: boolean;
  addedEvents: SidecarEvent[];
  updatedEvents: SidecarEvent[];
  removedEvents: SidecarEvent[];
} {
  const existingHooks = (parsed.hooks ?? {}) as HooksBlock;
  const nextHooks: HooksBlock = { ...existingHooks };
  const addedEvents: SidecarEvent[] = [];
  const updatedEvents: SidecarEvent[] = [];
  const removedEvents: SidecarEvent[] = [];

  const entriesOf = (event: SidecarEvent): HookEntry[] => {
    const raw = existingHooks[event];
    return Array.isArray(raw) ? (raw as HookEntry[]) : [];
  };

  for (const event of new Set([...events, ...HIGH_VOLUME_HOOK_EVENTS])) {
    const entries = entriesOf(event);
    const ours = entries.filter((e) => isProfilerEntry(e, target));
    if (ours.length === 0) {
      if (!events.includes(event)) continue;
      nextHooks[event] = [...entries, entryFor(event, target)];
      addedEvents.push(event);
    } else if (!areCurrentEntries(entries, event, target)) {
      nextHooks[event] = upgradeEntries(entries, event, target);
      updatedEvents.push(event);
    }
  }

  for (const event of RETIRED_HOOK_EVENTS) {
    const entries = entriesOf(event);
    if (!entries.some((e) => isProfilerEntry(e, target))) continue;
    const kept = entries
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !isProfilerCommand(h.command, target)) }))
      .filter((e) => e.hooks.length > 0);
    if (kept.length > 0) nextHooks[event] = kept;
    else delete nextHooks[event];
    removedEvents.push(event);
  }

  const changed = addedEvents.length + updatedEvents.length + removedEvents.length > 0;
  if (!changed) {
    return { next: parsed, alreadyInstalled: true, addedEvents, updatedEvents, removedEvents };
  }

  return { next: { ...parsed, hooks: nextHooks }, alreadyInstalled: false, addedEvents, updatedEvents, removedEvents };
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
  /** Where the hook script is deployed; settings.json points at the copy in it. */
  hookDir?: string;
  /** Where the compiled hook files are copied from. */
  hookSourceDir?: string;
  /**
   * What each hook entry runs, when not the default: the script in `hookDir`
   * for the npm package, this executable for the standalone build.
   */
  hookTarget?: string;
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
  /** Events whose existing entry was rewritten to the current shape. */
  updatedEvents: SidecarEvent[];
  /** Retired events whose entry was removed. */
  removedEvents: SidecarEvent[];
}

export async function installHooks(options: InstallOptions = {}): Promise<InstallResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const backupPath = options.backupPath ?? defaultBackupPath();
  const hookDir = options.hookDir ?? defaultHookDir();
  const target =
    options.hookTarget ?? (options.hookDir !== undefined ? resolveHookScriptPath(hookDir) : defaultHookTarget());
  // The standalone build runs itself as the hook; there is no script to copy.
  const deploy = () => {
    if (isScriptTarget(target)) deployHookScript(hookDir, options.hookSourceDir);
  };
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const confirm = options.confirm ?? defaultConfirm;
  const events = eventsToInstall(options.streamTiming ?? false);

  const { raw, parsed, existed } = readSettingsFile(settingsPath);
  const before = installedEvents(parsed, target);
  const { next, alreadyInstalled, addedEvents, updatedEvents, removedEvents } = computeInstalledSettings(
    parsed,
    target,
    events,
  );
  const changes = { addedEvents, updatedEvents, removedEvents };

  const runsNote = isScriptTarget(target) ? `hook script refreshed in ${hookDir}` : `hooks run ${target}`;

  if (alreadyInstalled) {
    deploy();
    return {
      status: "already-installed",
      message: `claude-profiler hooks are already installed (${before.length} events); ${runsNote}\n`,
      ...changes,
    };
  }

  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const diffText = formatDiff(raw, nextText);
  stdout(diffText);

  const approved = await confirm(diffText);
  if (!approved) {
    return {
      status: "aborted",
      message: "Install aborted; settings.json left unchanged.\n",
      addedEvents: [],
      updatedEvents: [],
      removedEvents: [],
    };
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

  // The script first, so settings.json never points at a file not there yet.
  deploy();
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, nextText);

  const plural = (n: number) => `${n} hook event${n === 1 ? "" : "s"}`;
  let summary = "";
  if (addedEvents.length > 0) {
    summary += `${upgrade ? "Added" : "Installed"} ${plural(addedEvents.length)} in ${settingsPath}\n  ${addedEvents.join(", ")}\n`;
  }
  if (updatedEvents.length > 0) {
    summary += `Updated ${plural(updatedEvents.length)} to the current hook settings\n  ${updatedEvents.join(", ")}\n`;
  }
  if (removedEvents.length > 0) {
    summary += `Removed ${plural(removedEvents.length)} no longer used\n  ${removedEvents.join(", ")}\n`;
  }
  const backupNote = upgrade
    ? `Pre-existing backup at ${backupPath} left untouched, so uninstall still restores your original settings.\n`
    : `Original backed up to ${backupPath}\n`;
  const scriptNote = isScriptTarget(target) ? `Hook script deployed to ${hookDir}\n` : `Hooks run ${target}\n`;

  return { status: "installed", message: summary + scriptNote + backupNote, ...changes };
}
