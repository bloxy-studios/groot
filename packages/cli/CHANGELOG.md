# create-groot

## 0.1.0

### Minor Changes

- [#6](https://github.com/bloxy-studios/groot/pull/6) [`8713f7c`](https://github.com/bloxy-studios/groot/commit/8713f7c2f36cfe23bc24a0079c51390353786b1f) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - Initial public release of the groot CLI skeleton 🌱

  - `groot --version` / `--help`, plus stubbed `init`, `add`, and `doctor` commands that point at the CLI spec and roadmap
  - npm-compatible `bin/groot.mjs` launcher (Bun shebang, friendly guidance when run without Bun)
  - Compiled standalone binaries for Linux x64/arm64, macOS x64/arm64, and Windows x64 — attached to GitHub Releases with SHA256 checksums and installable via `install.sh` / `install.ps1`

  The scaffolding engine (`groot init`) lands in v0.2 — see [docs/roadmap.md](https://github.com/bloxy-studios/groot/blob/main/docs/roadmap.md).
