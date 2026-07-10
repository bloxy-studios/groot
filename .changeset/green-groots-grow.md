---
"create-groot": minor
---

Initial public release of the groot CLI skeleton 🌱

- `groot --version` / `--help`, plus stubbed `init`, `add`, and `doctor` commands that point at the CLI spec and roadmap
- npm-compatible `bin/groot.mjs` launcher (Bun shebang, friendly guidance when run without Bun)
- Compiled standalone binaries for Linux x64/arm64, macOS x64/arm64, and Windows x64 — attached to GitHub Releases with SHA256 checksums and installable via `install.sh` / `install.ps1`

The scaffolding engine (`groot init`) lands in v0.2 — see [docs/roadmap.md](https://github.com/bloxy-studios/groot/blob/main/docs/roadmap.md).
