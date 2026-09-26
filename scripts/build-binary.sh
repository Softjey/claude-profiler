#!/bin/bash
# Builds the standalone claude-profiler: the CLI compiled into a Node single
# executable, so the machine it runs on needs no Node at all.
#
#   scripts/build-binary.sh   → build/binary/claude-profiler[.exe]
#                               build/binary/claude-profiler-<os>-<arch>.tar.gz (.zip on Windows)
#
# Builds for the platform it runs on (`node --build-sea` embeds the running
# node), so the release workflow runs it once per platform. Needs Node >= 25.5
# and `pnpm install` done; on Windows, Git Bash. On macOS the result is signed
# ad hoc.
set -euo pipefail

# Node, esbuild and PowerShell are native Windows programs and do not read the
# /c/... paths Git Bash uses; hand them C:/... instead.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$REPO_DIR/build/binary"
WORK_DIR="$BUILD_DIR/sea"
VERSION="$(node -p "require('$(native "$REPO_DIR")/package.json').version")"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
if (( node_major < 25 || (node_major == 25 && node_minor < 5) )); then
  echo "error: node --build-sea needs Node >= 25.5 (found $(node --version))" >&2
  exit 1
fi

# Named after the node being embedded, not `uname`: Git Bash on an arm64
# Windows machine can itself be an emulated x64 program.
case "$(node -p process.platform)" in
  darwin) os=darwin ;;
  linux) os=linux ;;
  win32) os=windows ;;
  *) echo "error: unsupported platform $(node -p process.platform)" >&2; exit 1 ;;
esac
case "$(node -p process.arch)" in
  arm64) arch=arm64 ;;
  x64) arch=x64 ;;
  *) echo "error: unsupported architecture $(node -p process.arch)" >&2; exit 1 ;;
esac
exe="claude-profiler"
[[ "$os" == windows ]] && exe="claude-profiler.exe"

rm -rf "$BUILD_DIR"
mkdir -p "$WORK_DIR"

echo "› bundling the CLI"
# ESM, not CJS: Ink has top-level await. The banner gives the bundled CommonJS
# dependencies (React) a real `require` for Node's built-in modules.
(cd "$REPO_DIR" && pnpm exec esbuild src/cli/standalone.ts \
  --bundle --platform=node --format=esm --target=node25 \
  --log-level=warning \
  --alias:react-devtools-core="$(native "$REPO_DIR/scripts/react-devtools-core-stub.js")" \
  --define:PROFILER_VERSION="\"$VERSION\"" \
  --banner:js="import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" \
  --outfile="$(native "$WORK_DIR/cli.mjs")")

cat > "$WORK_DIR/sea-config.json" <<EOF
{
  "main": "$(native "$WORK_DIR/cli.mjs")",
  "mainFormat": "module",
  "output": "$(native "$BUILD_DIR/$exe")",
  "disableExperimentalSEAWarning": true
}
EOF
echo "› building the executable"
node --build-sea "$(native "$WORK_DIR/sea-config.json")" >/dev/null

if [[ "$os" == darwin ]]; then
  echo "› signing (ad hoc)"
  # Injecting the bundle invalidates node's signature, and arm64 macOS kills
  # an executable whose signature does not verify.
  codesign --force --sign - "$BUILD_DIR/$exe"
fi

echo "› checking it runs"
built="$("$BUILD_DIR/$exe" --version)"
if [[ "$built" != "$VERSION" ]]; then
  echo "error: built binary reports '$built', expected '$VERSION'" >&2
  exit 1
fi
# As a hook: silent on stdout, one sidecar record written. Node looks for the
# home directory in USERPROFILE on Windows and HOME elsewhere.
home="$(mktemp -d)"
printed="$(echo '{"hook_event_name":"Stop","session_id":"build-check"}' |
  HOME="$home" USERPROFILE="$(native "$home")" "$BUILD_DIR/$exe" hook)"
if [[ -n "$printed" || ! -s "$home/.claude/profiler/build-check.jsonl" ]]; then
  echo "error: built binary does not work as a hook" >&2
  exit 1
fi
rm -rf "$home"

if [[ "$os" == windows ]]; then
  archive="claude-profiler-$os-$arch.zip"
  powershell.exe -NoProfile -NonInteractive -Command \
    "Compress-Archive -Path '$(native "$BUILD_DIR/$exe")' -DestinationPath '$(native "$BUILD_DIR/$archive")' -Force"
else
  archive="claude-profiler-$os-$arch.tar.gz"
  tar -czf "$BUILD_DIR/$archive" -C "$BUILD_DIR" "$exe"
fi
rm -rf "$WORK_DIR"
echo "✓ $BUILD_DIR/$exe ($os-$arch, $VERSION)"
echo "✓ $BUILD_DIR/$archive"
