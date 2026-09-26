// Entry point of the standalone build (scripts/build-binary.sh): the whole CLI
// in one executable that carries its own Node, so it runs wherever Node is
// missing or too old. The npm package starts from bin.ts instead.
//
// It is also its own hook: install-hooks, run from this build, registers
// `"<this executable>" hook` for every event.
//
// Both imports are static on purpose. Imported dynamically, esbuild turns the
// CLI into lazily initialised modules, and with Ink's top-level await inside
// an import cycle that initialisation never settles: the process just runs out
// of work and exits 0 without printing anything.
import { main as hookMain } from "../hooks/hook-script.js";
import { run } from "./index.js";

/** Replaced by esbuild (`--define:PROFILER_VERSION=...`) in scripts/build-binary.sh. */
declare const PROFILER_VERSION: string | undefined;
const version = typeof PROFILER_VERSION === "string" ? PROFILER_VERSION : "0.0.0";

const argv = process.argv.slice(2);

if (argv[0] === "hook") {
  // Same contract as hook-script.ts run under node: never fail, never print.
  try {
    await hookMain();
  } catch {
    // Nothing to report to: a hook's output goes back into the session.
  }
  process.exit(0);
}

process.exit(await run(argv, version));
