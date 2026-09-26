# Installs the standalone claude-profiler on Windows, which needs no Node:
#
#   irm https://raw.githubusercontent.com/Softjey/claude-profiler/master/install.ps1 | iex
#
# Environment:
#   CPROF_VERSION      a release to install, e.g. 0.2.0 (default: the latest)
#   CPROF_INSTALL_DIR  where to put it (default: %USERPROFILE%\.local\bin)
#   CPROF_DOWNLOAD_BASE  where the archives are, instead of the GitHub release
#                        (CI points it at the build it just made)
#
# Re-running it upgrades in place, so hooks registered by `install-hooks`,
# which point at the installed path, keep working.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with the progress bar

$repo = 'Softjey/claude-profiler'
$installDir = if ($env:CPROF_INSTALL_DIR) { $env:CPROF_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }

# The architecture of the machine, not of this PowerShell: an x64 PowerShell
# runs emulated on arm64 Windows and would report AMD64.
$machineArch = (Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
$arch = switch ($machineArch) {
  9 { 'x64' }
  12 { 'arm64' }
  default { throw "no prebuilt binary for this processor architecture ($machineArch); try 'npx claude-profiler' with Node 22+" }
}

$base = if ($env:CPROF_DOWNLOAD_BASE) {
  $env:CPROF_DOWNLOAD_BASE
} elseif ($env:CPROF_VERSION) {
  "https://github.com/$repo/releases/download/v$($env:CPROF_VERSION.TrimStart('v'))"
} else {
  "https://github.com/$repo/releases/latest/download"
}
$archive = "claude-profiler-windows-$arch.zip"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $archive..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile (Join-Path $tmp $archive)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')

  $expected = Get-Content (Join-Path $tmp 'checksums.txt') |
    ForEach-Object { $sum, $name = -split $_; if ($name -eq $archive) { $sum } } |
    Select-Object -First 1
  if (-not $expected) { throw "$archive is not listed in checksums.txt" }
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $archive)).Hash
  if ($actual -ne $expected) { throw "checksum mismatch for $archive" }

  Expand-Archive -Path (Join-Path $tmp $archive) -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null

  # Windows will not overwrite an executable while it runs, and a hook may be
  # running it right now; it will rename one, so the old copy steps aside.
  $target = Join-Path $installDir 'claude-profiler.exe'
  if (Test-Path $target) {
    $old = "$target.old"
    Remove-Item $old -Force -ErrorAction SilentlyContinue
    Move-Item $target $old -Force
  }
  Move-Item (Join-Path $tmp 'claude-profiler.exe') $target -Force

  # `cprof` as a shim: a symlink would need Developer Mode or an admin shell.
  Set-Content -Path (Join-Path $installDir 'cprof.cmd') -Value "@`"%~dp0claude-profiler.exe`" %*" -Encoding Ascii

  $version = & $target --version
  Write-Host "Installed claude-profiler $version to $installDir"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = if ($userPath) { $userPath -split ';' } else { @() }
  if ($entries -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $installDir) -join ';'), 'User')
    Write-Host "Added $installDir to your PATH; open a new terminal to run 'claude-profiler' or 'cprof'."
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
