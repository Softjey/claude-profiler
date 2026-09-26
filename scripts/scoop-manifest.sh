#!/bin/bash
# Prints the Scoop manifest for a release of the standalone build, for the
# bucket at github.com/Softjey/scoop-bucket:
#
#   scripts/scoop-manifest.sh 0.2.0 checksums.txt > bucket/claude-profiler.json
#
# `checksums.txt` is the release's: "<sha256>  claude-profiler-<os>-<arch>.<ext>"
# per line, as `sha256sum` writes it.
set -euo pipefail

version="${1:?usage: $0 <version> <checksums.txt>}"
checksums="${2:?usage: $0 <version> <checksums.txt>}"
base="https://github.com/Softjey/claude-profiler/releases/download/v$version"

sha() {
  local sum
  sum="$(awk -v f="claude-profiler-$1.zip" '$2 == f || $2 == "*" f { print $1 }' "$checksums")"
  if [[ -z "$sum" ]]; then
    echo "error: claude-profiler-$1.zip is not in $checksums" >&2
    exit 1
  fi
  echo "$sum"
}

# Looked up before the heredoc: a failure inside its $(...) would not stop the
# script, and a manifest with an empty hash would go out.
windows_x64="$(sha windows-x64)"
windows_arm64="$(sha windows-arm64)"

cat <<EOF
{
  "version": "$version",
  "description": "See where the time went in a Claude Code session",
  "homepage": "https://github.com/Softjey/claude-profiler",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "$base/claude-profiler-windows-x64.zip",
      "hash": "$windows_x64"
    },
    "arm64": {
      "url": "$base/claude-profiler-windows-arm64.zip",
      "hash": "$windows_arm64"
    }
  },
  "bin": [
    "claude-profiler.exe",
    ["claude-profiler.exe", "cprof"]
  ]
}
EOF
