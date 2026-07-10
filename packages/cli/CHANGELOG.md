# create-groot

## 0.2.1

### Patch Changes

- [#14](https://github.com/bloxy-studios/groot/pull/14) [`05fd83f`](https://github.com/bloxy-studios/groot/commit/05fd83fe3dc9c0ebfe893f39b24db1be89929e7d) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - Fix: Convex backends now typecheck — `convex dev` no longer fails with TS2688

  The vendored `convex/tsconfig.json` declares `"types": ["node"]`, but the generated `packages/backend/package.json` was missing `@types/node`, so `convex dev`'s built-in typecheck failed on first login (`error TS2688: Cannot find type definition file for 'node'`). The dependency is now included (pin tracks the upstream Convex template), and the E2E suite typechecks scaffolded packages — not just installs them — so this class of bug can't ship again.

  Also documented: Convex's optional AI-files step installs agent skills via `npx`, which npm's `devEngines` guard correctly rejects inside groot's bun-declared workspaces (`EBADDEVENGINES`) — cosmetic, Convex continues and prints a manual retry command.

## 0.2.0

### Minor Changes

- [#12](https://github.com/bloxy-studios/groot/pull/12) [`5af285b`](https://github.com/bloxy-studios/groot/commit/5af285b9e4f067145acb8e87e6e9dd8cd310f299) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - 🌳 v0.2 — `groot init` is real: plant a complete bun-first Turborepo in one command

  - **The full pipeline**: resolve (flags + interactive prompts) → preflight → generate → stitch → verify. `bun create groot my-app` produces an installed, git-initialized, coherent workspace.
  - **The full scaffold matrix**: Next.js or SvelteKit (`apps/web`), Expo (`apps/mobile`), Elysia or Hono (`apps/api`), Convex (`packages/backend`, default) — orchestrating the official generators with pinned majors, and writing Elysia/Convex directly (including the standard Convex `_generated` stubs, adapted for bun-first workspaces).
  - **Coherence out of the box**: bare app package names, one root lockfile, non-conflicting dev ports (Hono/Elysia on 3001), `@repo/backend` workspace links + env placeholders, per-framework turbo build outputs, and a `groot.json` manifest with a published JSON schema.
  - **Automation-grade**: `--yes`, `--dry-run` (+ pure-stdout `--json` plan), `--dir-conflict error|merge|increment`, `--no-install`, `--no-git`, `--keep-failed`, spec'd exit codes, and a hard guarantee of never hanging on a prompt in CI.
  - Real-generator E2E now runs in CI on every PR and on a weekly upstream-drift cron.

  `groot add` and `groot doctor` arrive in v0.3 — the stubs point at the spec and roadmap.

## 0.1.0

### Minor Changes

- [#6](https://github.com/bloxy-studios/groot/pull/6) [`8713f7c`](https://github.com/bloxy-studios/groot/commit/8713f7c2f36cfe23bc24a0079c51390353786b1f) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - Initial public release of the groot CLI skeleton 🌱

  - `groot --version` / `--help`, plus stubbed `init`, `add`, and `doctor` commands that point at the CLI spec and roadmap
  - npm-compatible `bin/groot.mjs` launcher (Bun shebang, friendly guidance when run without Bun)
  - Compiled standalone binaries for Linux x64/arm64, macOS x64/arm64, and Windows x64 — attached to GitHub Releases with SHA256 checksums and installable via `install.sh` / `install.ps1`

  The scaffolding engine (`groot init`) lands in v0.2 — see [docs/roadmap.md](https://github.com/bloxy-studios/groot/blob/main/docs/roadmap.md).
