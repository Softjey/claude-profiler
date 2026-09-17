import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

interface HooksBlock {
  PreToolUse?: HookEntry[];
  PostToolUse?: HookEntry[];
  [key: string]: unknown;
}

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

export function areHooksInstalled(
  settingsPath: string = defaultSettingsPath(),
  scriptPath: string = resolveHookScriptPath(),
): boolean {
  const { parsed } = readSettingsFile(settingsPath);
  return computeInstalledSettings(parsed, scriptPath).alreadyInstalled;
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
  return entry.hooks.some((h) => h.command === hookCommand(scriptPath));
}

export function computeInstalledSettings(
  parsed: Settings,
  scriptPath: string,
): { next: Settings; alreadyInstalled: boolean } {
  const existingPre = parsed.hooks?.PreToolUse ?? [];
  const existingPost = parsed.hooks?.PostToolUse ?? [];

  const alreadyInstalled =
    existingPre.some((e) => isProfilerEntry(e, scriptPath)) &&
    existingPost.some((e) => isProfilerEntry(e, scriptPath));

  if (alreadyInstalled) {
    return { next: parsed, alreadyInstalled: true };
  }

  const entry: HookEntry = { matcher: "*", hooks: [{ type: "command", command: hookCommand(scriptPath) }] };

  const next: Settings = {
    ...parsed,
    hooks: {
      ...parsed.hooks,
      PreToolUse: [...existingPre, entry],
      PostToolUse: [...existingPost, entry],
    },
  };

  return { next, alreadyInstalled: false };
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
  confirm?: (diffText: string) => Promise<boolean> | boolean;
  stdout?: (s: string) => void;
}

export interface InstallResult {
  status: "installed" | "already-installed" | "aborted";
  message: string;
}

export async function installHooks(options: InstallOptions = {}): Promise<InstallResult> {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const backupPath = options.backupPath ?? defaultBackupPath();
  const scriptPath = options.scriptPath ?? resolveHookScriptPath();
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const confirm = options.confirm ?? defaultConfirm;

  const { raw, parsed, existed } = readSettingsFile(settingsPath);
  const { next, alreadyInstalled } = computeInstalledSettings(parsed, scriptPath);

  if (alreadyInstalled) {
    return { status: "already-installed", message: "claude-profiler hooks are already installed.\n" };
  }

  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const diffText = formatDiff(raw, nextText);
  stdout(diffText);

  const approved = await confirm(diffText);
  if (!approved) {
    return { status: "aborted", message: "Install aborted; settings.json left unchanged.\n" };
  }

  const backup: Backup = { existed, raw };
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, JSON.stringify(backup));

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, nextText);

  return {
    status: "installed",
    message: `Installed PreToolUse/PostToolUse hooks in ${settingsPath}\nOriginal backed up to ${backupPath}\n`,
  };
}
