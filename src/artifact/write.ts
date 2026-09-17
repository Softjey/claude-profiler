import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Profile } from "./profile.js";

/** FR20 default: `~/.claude/profiler/profiles/<sessionId>.json`. */
export function defaultProfilePath(sessionId: string): string {
  return join(homedir(), ".claude", "profiler", "profiles", `${sessionId}.json`);
}

/**
 * Writes the artifact to `outPath` or the default path (FR18/FR20). Callers
 * must have already run the profile through `assertProfileInvariants` —
 * this function only serializes.
 */
export async function writeProfileArtifact(profile: Profile, outPath?: string): Promise<string> {
  const path = outPath ?? defaultProfilePath(profile.session.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return path;
}
