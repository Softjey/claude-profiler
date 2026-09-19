import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_FILES, installHooks } from "./install.js";
import { uninstallHooks } from "./uninstall.js";

describe("uninstallHooks", () => {
  let dir: string;
  let settingsPath: string;
  let backupPath: string;
  let hookDir: string;
  let hookSourceDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-uninstall-"));
    settingsPath = join(dir, "settings.json");
    backupPath = join(dir, "backup.json");
    hookDir = join(dir, "profiler", "hooks");
    hookSourceDir = join(dir, "package-dist");
    await mkdir(hookSourceDir);
    for (const file of HOOK_FILES) await writeFile(join(hookSourceDir, file), "");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports no-backup when nothing was ever installed", () => {
    const result = uninstallHooks({ settingsPath, backupPath, hookDir });
    expect(result.status).toBe("no-backup");
  });

  it("restores settings.json byte-identical to before install, and removes the backup", async () => {
    const original = '{\n  "model": "sonnet",\n  "permissions": { "defaultMode": "auto" }\n}\n';
    await writeFile(settingsPath, original);

    await installHooks({ settingsPath, backupPath, hookDir, hookSourceDir, confirm: () => true, stdout: () => {} });
    expect(await readFile(settingsPath, "utf8")).not.toBe(original);

    const result = uninstallHooks({ settingsPath, backupPath, hookDir });

    expect(result.status).toBe("restored");
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    expect(existsSync(backupPath)).toBe(false);
    expect(existsSync(hookDir)).toBe(false);
  });

  it("deletes settings.json on uninstall when it did not exist before install", async () => {
    await installHooks({ settingsPath, backupPath, hookDir, hookSourceDir, confirm: () => true, stdout: () => {} });
    expect(existsSync(settingsPath)).toBe(true);

    const result = uninstallHooks({ settingsPath, backupPath, hookDir });

    expect(result.status).toBe("restored");
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });
});
