import { runLive } from "./run.js";

/**
 * Standalone entry for the collector alone — what the macOS app bundles as a
 * single executable. It skips cli/index.ts so the bundle carries none of the
 * TUI's dependencies, and avoids top-level await so it can be bundled as CJS,
 * the only format a Node single executable runs on every supported version.
 */
void runLive({ once: process.argv.includes("--once") }).then((exitCode) => process.exit(exitCode));
