#!/bin/bash
# Builds the standalone claude-profiler: the CLI compiled into a Node single
# executable, so the machine it runs on needs no Node at all.
#
#   scripts/build-binary.sh   → build/binary/claude-profiler
#                               build/binary/claude-profiler-<os>-<arch>.tar.gz
#
# Builds for the platform it runs on (`node --build-sea` embeds the running
# node), so the release workflow runs it once per platform. Needs Node >= 25.5
# and `pnpm install` done. On macOS the result is signed ad hoc.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_DIR/build/binary"
WORK_DIR="$BUILD_DIR/sea"
VERSION="$(node -p "require('$REPO_DIR/package.json').version")"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
if (( node_major < 25 || (node_major == 25 && node_minor < 5) )); then
  echo "error: node --build-sea needs Node >= 25.5 (found $(node --version))" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "error: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

rm -rf "$BUILD_DIR"
mkdir -p "$WORK_DIR"

echo "› bundling the CLI"
# ESM, not CJS: Ink has top-level await. The banner gives the bundled CommonJS
# dependencies (React) a real `require` for Node's built-in modules.
(cd "$REPO_DIR" && pnpm exec esbuild src/cli/standalone.ts \
  --bundle --platform=node --format=esm --target=node25 \
  --log-level=warning \
  --alias:react-devtools-core="$REPO_DIR/scripts/react-devtools-core-stub.js" \
  --define:PROFILER_VERSION="\"$VERSION\"" \
  --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
  --outfile="$WORK_DIR/cli.mjs")

cat > "$WORK_DIR/sea-config.json" <<EOF
{
  "main": "$WORK_DIR/cli.mjs",
  "mainFormat": "module",
  "output": "$BUILD_DIR/claude-profiler",
  "disableExperimentalSEAWarning": true
}
EOF
echo "› building the executable"
node --build-sea "$WORK_DIR/sea-config.json" >/dev/null

if [[ "$os" == darwin ]]; then
  echo "› signing (ad hoc)"
  # Injecting the bundle invalidates node's signature, and arm64 macOS kills
  # an executable whose signature does not verify.
  codesign --force --sign - "$BUILD_DIR/claude-profiler"
fi

echo "› checking it runs"
built="$("$BUILD_DIR/claude-profiler" --version)"
if [[ "$built" != "$VERSION" ]]; then
  echo "error: built binary reports '$built', expected '$VERSION'" >&2
  exit 1
fi
# As a hook: silent on stdout, one sidecar record written.
home="$(mktemp -d)"
printed="$(echo '{"hook_event_name":"Stop","session_id":"build-check"}' | HOME="$home" "$BUILD_DIR/claude-profiler" hook)"
if [[ -n "$printed" || ! -s "$home/.claude/profiler/build-check.jsonl" ]]; then
  echo "error: built binary does not work as a hook" >&2
  exit 1
fi
rm -rf "$home"

archive="claude-profiler-$os-$arch.tar.gz"
tar -czf "$BUILD_DIR/$archive" -C "$BUILD_DIR" claude-profiler
rm -rf "$WORK_DIR"
echo "✓ $BUILD_DIR/claude-profiler ($os-$arch, $VERSION)"
echo "✓ $BUILD_DIR/$archive"
