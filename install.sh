#!/usr/bin/env bash
# groot installer — installs the standalone `groot` binary from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/bloxy-studios/groot/main/install.sh | bash
#
# Install a specific version:
#   curl -fsSL https://raw.githubusercontent.com/bloxy-studios/groot/main/install.sh | GROOT_VERSION=0.1.0 bash
#
# Custom install location (default: ~/.groot):
#   curl -fsSL https://raw.githubusercontent.com/bloxy-studios/groot/main/install.sh | GROOT_INSTALL=~/.local bash
#
# Every download is verified against the release's SHA256SUMS.txt before installing.
# This script deliberately does NOT edit your shell profile — it prints the one line to add.

set -euo pipefail

REPO="bloxy-studios/groot"
TAG_PREFIX="create-groot@"

# --- output helpers (colors only on a TTY) ----------------------------------
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')" GREEN="$(printf '\033[32m')" YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')" CYAN="$(printf '\033[36m')" RESET="$(printf '\033[0m')"
else
  BOLD="" GREEN="" YELLOW="" RED="" CYAN="" RESET=""
fi

info() { printf '%s\n' "${GREEN}groot${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}groot${RESET} $*" >&2; }
fail() {
  printf '%s\n' "${RED}groot error:${RESET} $*" >&2
  exit 1
}

# --- preflight ---------------------------------------------------------------
command -v curl >/dev/null 2>&1 || fail "curl is required but not found."

case "$(uname -s)" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "On Windows, use PowerShell instead:
  powershell -c \"irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex\""
    ;;
  *) fail "Unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) fail "Unsupported architecture: $(uname -m). Prebuilt binaries cover x64 and arm64 — use 'bunx create-groot' instead." ;;
esac

# musl libc (e.g. Alpine) is not covered by the published glibc builds.
if [ "$os" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
  fail "musl-based Linux detected. Prebuilt binaries target glibc — use 'bunx create-groot' instead."
fi

target="groot-${os}-${arch}"

# --- resolve version & URLs ---------------------------------------------------
version="${GROOT_VERSION:-${1:-}}"
version="${version#v}" # tolerate a leading v

if [ -n "$version" ]; then
  base_url="https://github.com/${REPO}/releases/download/${TAG_PREFIX}${version}"
  info "installing groot ${BOLD}${version}${RESET} (${target})"
else
  base_url="https://github.com/${REPO}/releases/latest/download"
  info "installing the ${BOLD}latest${RESET} groot release (${target})"
fi

install_root="${GROOT_INSTALL:-$HOME/.groot}"
bin_dir="${install_root}/bin"
exe="${bin_dir}/groot"

# --- download -----------------------------------------------------------------
tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

download() {
  # HTTPS only, modern TLS, fail on HTTP errors, follow the release redirect.
  curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2" ||
    fail "download failed: $1
Check https://github.com/${REPO}/releases for available versions."
}

info "downloading ${target}…"
download "${base_url}/${target}" "${tmp_dir}/${target}"
download "${base_url}/SHA256SUMS.txt" "${tmp_dir}/SHA256SUMS.txt"

# --- verify checksum ----------------------------------------------------------
expected="$(awk -v t="$target" '$2 == t { print $1 }' "${tmp_dir}/SHA256SUMS.txt")"
[ -n "$expected" ] || fail "no checksum entry for ${target} in SHA256SUMS.txt — refusing to install."

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp_dir}/${target}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmp_dir}/${target}" | awk '{ print $1 }')"
else
  fail "neither sha256sum nor shasum found — cannot verify the download."
fi

if [ "$expected" != "$actual" ]; then
  fail "checksum mismatch for ${target}!
  expected: ${expected}
  actual:   ${actual}
The download may be corrupted or tampered with. Nothing was installed."
fi
info "checksum verified ✓"

# --- install ------------------------------------------------------------------
mkdir -p "$bin_dir"
mv "${tmp_dir}/${target}" "$exe"
chmod 755 "$exe"

installed_version="$("$exe" --version 2>/dev/null || true)"
info "installed groot ${installed_version:+${BOLD}${installed_version}${RESET} }→ ${exe}"

# --- PATH guidance (no profile editing on purpose) -----------------------------
case ":$PATH:" in
  *":${bin_dir}:"*)
    info "you're all set — run ${BOLD}groot --help${RESET}"
    ;;
  *)
    warn "${bin_dir} is not on your PATH. Add it:"
    shell_name="$(basename "${SHELL:-sh}")"
    case "$shell_name" in
      zsh) printf '\n  %s\n\n' "${CYAN}echo 'export PATH=\"${bin_dir}:\$PATH\"' >> ~/.zshrc && source ~/.zshrc${RESET}" ;;
      fish) printf '\n  %s\n\n' "${CYAN}fish_add_path ${bin_dir}${RESET}" ;;
      *) printf '\n  %s\n\n' "${CYAN}echo 'export PATH=\"${bin_dir}:\$PATH\"' >> ~/.bashrc && source ~/.bashrc${RESET}" ;;
    esac
    ;;
esac
