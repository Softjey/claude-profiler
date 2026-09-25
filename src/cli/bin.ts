#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
};

// Checked before anything else loads: the TUI's dependencies declare
// regexes with the `v` flag at module level, which an older Node rejects
// while parsing them — a bare "Invalid regular expression flags" with a
// stack into node_modules, before any of our code gets to say why.
const required = Number(/\d+/.exec(pkg.engines.node)?.[0]);
const current = Number(process.versions.node.split(".")[0]);
if (current < required) {
  process.stderr.write(
    `claude-profiler needs Node.js ${pkg.engines.node}, but this is Node.js ${process.versions.node}.\n` +
      `Upgrade Node (e.g. \`nvm install ${required}\`, or see https://nodejs.org/en/download) and run it again.\n`,
  );
  process.exit(1);
}

const { run } = await import("./index.js");
const exitCode = await run(process.argv.slice(2), pkg.version);
process.exit(exitCode);
