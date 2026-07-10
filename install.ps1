#!/usr/bin/env pwsh
# groot installer for Windows — installs the standalone groot.exe from GitHub Releases.
#
# Usage:
#   powershell -c "irm https://raw.githubusercontent.com/bloxy-studios/groot/main/install.ps1 | iex"
#
# Install a specific version:
#   powershell -c "$env:GROOT_VERSION='0.1.0'; irm https://raw.githubusercontent.com/bloxy-studios/groot/main/install.ps1 | iex"
#
# Custom install location (default: %USERPROFILE%\.groot):
#   powershell -c "$env:GROOT_INSTALL='D:\tools'; irm https://raw.githubusercontent.com/bloxy-studios/groot/main/install.ps1 | iex"
#
# Every download is verified against the release's SHA256SUMS.txt before installing.

$ErrorActionPreference = "Stop"

$Repo = "bloxy-studios/groot"
$TagPrefix = "create-groot@"
$Asset = "groot-windows-x64.exe"

function Write-Info([string]$Message) { Write-Host "groot " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Fail([string]$Message) { Write-Host "groot error: $Message" -ForegroundColor Red; exit 1 }

# --- preflight ---------------------------------------------------------------
if (-not [Environment]::Is64BitOperatingSystem) {
  Fail "32-bit Windows is not supported."
}
$IsArm64 = ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") -or ($env:PROCESSOR_ARCHITEW6432 -eq "ARM64")
if ($IsArm64) {
  Fail "Windows arm64 binaries are not published yet - use 'bunx create-groot' instead (https://bun.sh)."
}

# Ensure modern TLS on Windows PowerShell 5.x (no-op on PowerShell 7+).
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # PowerShell 7+ negotiates TLS 1.2+ by default.
}

# --- resolve version & URLs ---------------------------------------------------
$Version = $env:GROOT_VERSION
if ($Version) {
  $Version = $Version.TrimStart("v")
  $BaseUrl = "https://github.com/$Repo/releases/download/$TagPrefix$Version"
  Write-Info "installing groot $Version ($Asset)"
} else {
  $BaseUrl = "https://github.com/$Repo/releases/latest/download"
  Write-Info "installing the latest groot release ($Asset)"
}

$InstallRoot = if ($env:GROOT_INSTALL) { $env:GROOT_INSTALL } else { Join-Path $env:USERPROFILE ".groot" }
$BinDir = Join-Path $InstallRoot "bin"
$Exe = Join-Path $BinDir "groot.exe"

# --- download -----------------------------------------------------------------
$TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("groot-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
  $TmpExe = Join-Path $TmpDir $Asset
  $TmpSums = Join-Path $TmpDir "SHA256SUMS.txt"

  Write-Info "downloading $Asset..."
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$Asset" -OutFile $TmpExe
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $TmpSums
  } catch {
    Fail "download failed: $($_.Exception.Message)`nCheck https://github.com/$Repo/releases for available versions."
  }

  # --- verify checksum --------------------------------------------------------
  $SumLine = Get-Content $TmpSums | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
  if (-not $SumLine) {
    Fail "no checksum entry for $Asset in SHA256SUMS.txt - refusing to install."
  }
  $Expected = ($SumLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $TmpExe).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) {
    Fail "checksum mismatch for $Asset!`n  expected: $Expected`n  actual:   $Actual`nThe download may be corrupted or tampered with. Nothing was installed."
  }
  Write-Info "checksum verified"

  # --- install ----------------------------------------------------------------
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  Move-Item -Force -Path $TmpExe -Destination $Exe

  # --- PATH (user scope) ------------------------------------------------------
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not ($UserPath -split ";" | Where-Object { $_ -eq $BinDir })) {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$UserPath", "User")
    Write-Info "added $BinDir to your user PATH (restart your terminal to pick it up)"
  }
  # Make groot available in this session too.
  $env:Path = "$BinDir;$env:Path"

  $InstalledVersion = & $Exe --version
  Write-Info "installed groot $InstalledVersion -> $Exe"
  Write-Info "run 'groot --help' to get started"
} finally {
  Remove-Item -Recurse -Force -Path $TmpDir -ErrorAction SilentlyContinue
}
