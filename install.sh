#!/bin/sh
# Installs the standalone claude-profiler, which needs no Node:
#
#   curl -fsSL https://raw.githubusercontent.com/Softjey/claude-profiler/master/install.sh | sh
#
# Environment:
#   CPROF_VERSION      a release to install, e.g. 0.2.0 (default: the latest)
#   CPROF_INSTALL_DIR  where to put it (default: ~/.local/bin)
#
# Re-running it upgrades in place, so hooks registered by `install-hooks`,
# which point at the installed path, keep working.
set -eu

repo="Softjey/claude-profiler"
install_dir="${CPROF_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "error: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "no prebuilt binary for $(uname -s); try 'npx claude-profiler' with Node 22+" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "no prebuilt binary for $(uname -m); try 'npx claude-profiler' with Node 22+" ;;
esac

if [ -n "${CPROF_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/v${CPROF_VERSION#v}"
else
  base="https://github.com/$repo/releases/latest/download"
fi
archive="claude-profiler-$os-$arch.tar.gz"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
else
  fail "needs curl or wget"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $archive..."
fetch "$base/$archive" "$tmp/$archive" || fail "could not download $base/$archive"
fetch "$base/checksums.txt" "$tmp/checksums.txt" || fail "could not download $base/checksums.txt"

expected="$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/checksums.txt")"
[ -n "$expected" ] || fail "$archive is not listed in checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$archive" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$tmp/$archive" | awk '{ print $1 }')"
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $archive"

tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$install_dir"
# Moved into place rather than written over: a hook may be running the old
# binary at this very moment.
mv -f "$tmp/claude-profiler" "$install_dir/claude-profiler"
ln -sf claude-profiler "$install_dir/cprof"

echo "Installed claude-profiler $("$install_dir/claude-profiler" --version) to $install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to your PATH to run it as 'claude-profiler' or 'cprof'." ;;
esac
