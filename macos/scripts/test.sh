#!/bin/bash
# Runs the Swift tests. With only the Command Line Tools installed (no Xcode),
# SwiftPM does not find the Testing framework on its own, so point it there.
set -euo pipefail
cd "$(dirname "$0")/.."

CLT=/Library/Developer/CommandLineTools/Library/Developer
flags=()
if [[ "$(xcode-select -p)" == /Library/Developer/CommandLineTools* && -d "$CLT/Frameworks" ]]; then
  flags=(
    -Xswiftc -F -Xswiftc "$CLT/Frameworks"
    -Xlinker -F -Xlinker "$CLT/Frameworks"
    -Xlinker -rpath -Xlinker "$CLT/Frameworks"
    -Xlinker -rpath -Xlinker "$CLT/usr/lib"
  )
fi

swift test "${flags[@]}" "$@"
