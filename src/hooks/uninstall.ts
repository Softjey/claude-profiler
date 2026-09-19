import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultBackupPath, defaultHookDir, defaultSettingsPath } from "./install.js";

interface Backup {
  existed: boolean;
  raw: string;
}

export interface UninstallOptions {
  settingsPath?: string;
  backupPath?: string;
  hookDir?: string;
}

export interface UninstallResult {
  status: "restored" | "no-backup";
  message: string;
}

/**
 * Restores settings.json from the backup install.ts wrote, byte-for-byte — removing
 * exactly the entries this tool added and nothing else, since the backup is the file as
 * it stood the instant before install() touched it. The deployed hook script goes
 * too: nothing points at it any more.
 */
export function uninstallHooks(options: UninstallOptions = {}): UninstallResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const backupPath = options.backupPath ?? defaultBackupPath();
  const hookDir = options.hookDir ?? defaultHookDir();

  if (!existsSync(backupPath)) {
    return { status: "no-backup", message: "No claude-profiler hook install found; nothing to uninstall.\n" };
  }

  const backup = JSON.parse(readFileSync(backupPath, "utf8")) as Backup;

  if (backup.existed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, backup.raw);
  } else if (existsSync(settingsPath)) {
    rmSync(settingsPath);
  }

  rmSync(backupPath);
  rmSync(hookDir, { recursive: true, force: true });

  return { status: "restored", message: `Restored ${settingsPath}; claude-profiler hooks uninstalled.\n` };
}
