import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooks } from "./install.js";
import { uninstallHooks } from "./uninstall.js";

describe("uninstallHooks", () => {
  let dir: string;
  let settingsPath: string;
  let backupPath: string;
  const scriptPath = "/opt/claude-profiler/dist/hooks/hook-script.js";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-uninstall-"));
    settingsPath = join(dir, "settings.json");
    backupPath = join(dir, "backup.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports no-backup when nothing was ever installed", () => {
    const result = uninstallHooks({ settingsPath, backupPath });
    expect(result.status).toBe("no-backup");
  });

  it("restores settings.json byte-identical to before install, and removes the backup", async () => {
    const original = '{\n  "model": "sonnet",\n  "permissions": { "defaultMode": "auto" }\n}\n';
    await writeFile(settingsPath, original);

    await installHooks({ settingsPath, backupPath, scriptPath, confirm: () => true, stdout: () => {} });
    expect(await readFile(settingsPath, "utf8")).not.toBe(original);

    const result = uninstallHooks({ settingsPath, backupPath });

    expect(result.status).toBe("restored");
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    expect(existsSync(backupPath)).toBe(false);
  });

  it("deletes settings.json on uninstall when it did not exist before install", async () => {
    await installHooks({ settingsPath, backupPath, scriptPath, confirm: () => true, stdout: () => {} });
    expect(existsSync(settingsPath)).toBe(true);

    const result = uninstallHooks({ settingsPath, backupPath });

    expect(result.status).toBe("restored");
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
  });
});
