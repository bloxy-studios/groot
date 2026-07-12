# create-groot

## 1.1.0

### Minor Changes

- [#56](https://github.com/bloxy-studios/groot/pull/56) [`fa79194`](https://github.com/bloxy-studios/groot/commit/fa791949e360a1880c96bb64eabc547cfa3248ac) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - New desktop slot with the Tauri v2 adapter — the first slot added since the original matrix, opening milestone v1.1. `groot init --desktop tauri` (or the new "Desktop app?" prompt) and `groot add tauri` grow `apps/desktop` from the official `create-tauri-app` (react-ts template, bun manager, workspace-derived bundle identifier), keeping the template's own coupled dev port 1420 (Vite strictPort + tauri.conf.json devUrl — unique in the matrix). Rust is only needed at dev time: scaffolding and `bun install` work without it, next-steps point at rustup, and `groot doctor` gains desktop checks (tauri config presence, devUrl/port consistency, a cargo warn, vite config tripwire). Additive manifest change: the schema's slot/framework enums grow `desktop`/`tauri` — existing manifests stay valid, `version` stays 1.

## 1.0.2

### Patch Changes

- [#33](https://github.com/bloxy-studios/groot/pull/33) [`65aacf3`](https://github.com/bloxy-studios/groot/commit/65aacf373844b9ca67151ce60d6ec42a32da726e) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - npm README: replace the stale v0.1 pre-release banner ("ships the CLI skeleton… full `groot init` lands in v0.2") with the v1.0 stable banner. The npm package page was still describing create-groot as a skeleton awaiting v0.2 while the published CLI was at 1.0.x.

## 1.0.1

### Patch Changes

- [#31](https://github.com/bloxy-studios/groot/pull/31) [`630ef22`](https://github.com/bloxy-studios/groot/commit/630ef222e99c0bd2a451747ed32fd92018d0734e) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - Fix git nesting: generators can no longer leave a `.git` inside a scaffold. `create-expo-app` has no git-suppression flag and initializes a repo whenever it doesn't detect an enclosing one — always the case during `groot init`, where the root `git init` runs after generation — so every workspace with a mobile app grew a nested `apps/mobile/.git` (and `groot doctor` flagged it). The engine now removes any generator-created `.git` immediately after each scaffold grows, in both `init` and `groot add`. A `.git` that existed before the grow (`--dir-conflict merge` onto a directory you already track) is yours and is preserved. Existing workspaces with the problem: run the doctor-suggested fix (`rm -rf apps/mobile/.git`).

## 1.0.0

### Major Changes

- [#29](https://github.com/bloxy-studios/groot/pull/29) [`79278c9`](https://github.com/bloxy-studios/groot/commit/79278c91d0e2280794b2e66dd023f1e15375e51b) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - v1.0.0 — the stability contract is binding.

  No behavior changes in this release: it seals the contract [docs/stability.md](https://github.com/bloxy-studios/groot/blob/main/docs/stability.md) defines. The `init`/`add`/`doctor` command set and every documented flag, the exit-code table, the versioned `groot.json` manifest schema, and the non-interactive + `--json` guarantees are covered by semver from here on — breaking any of them requires a major release. The covered surface is tripwired by the contract snapshot tests in `packages/cli/src/contract.test.ts`.

## 0.5.0

### Minor Changes

- [#22](https://github.com/bloxy-studios/groot/pull/22) [`6c17c1e`](https://github.com/bloxy-studios/groot/commit/6c17c1e9143982d8db46f5fbfdf98bf8dca5fecd) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - `groot add --dry-run --json` — the manifest as `groot.json` would read after the add, on pure stdout: the same versioned schema `init --dry-run --json` emits, with the new scaffold as the final entry. Diagnostics and port-collision warnings route to stderr, so agents and CI can parse stdout directly. Machine-readable output now covers every command: `init`, `add`, and `doctor`.

## 0.4.0

### Minor Changes

- [#20](https://github.com/bloxy-studios/groot/pull/20) [`16909c6`](https://github.com/bloxy-studios/groot/commit/16909c6c29e3d6d7d9ccb34d9af647669c9a7f46) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - `groot init --preset <path>` — replicate a workspace shape from any groot.json (a file, or a workspace directory containing one). The preset is the **selections source**: slot → framework comes from the manifest, validated exactly like a workspace manifest, while the workspace name, paths, ports, generator pins, and conventions come from the current CLI — a preset written by an older groot never pins stale generators. Explicit slot flags win over the preset; extra same-slot scaffolds (grown via `groot add --path`) surface as warnings. With a target directory given, a preset run is fully non-interactive.

## 0.3.0

### Minor Changes

- [#18](https://github.com/bloxy-studios/groot/pull/18) [`94b947f`](https://github.com/bloxy-studios/groot/commit/94b947fe68851cfd06834d89f8e98befead03628) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - `groot add <scaffold>` — grow an existing workspace with one more scaffold. The same grow → stitch → verify pipeline as `init` runs for just the new scaffold: occupancy-checked destinations (`--path` unlocks a second scaffold per slot), automatic cross-wiring (adding convex links the existing frontends to the backend), a persistent `groot.json` update with provenance preserved, and targeted rollback that removes only the new scaffold directory on generator failure. Flags: `--path`, `--no-install`, `--keep-failed`, `--dry-run`, `--verbose`.

- [#16](https://github.com/bloxy-studios/groot/pull/16) [`546856a`](https://github.com/bloxy-studios/groot/commit/546856a9e296a47c7cac227866a2a4baabd82064) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - `groot doctor` — workspace health checks with suggested fixes: groot.json validation with walk-up discovery, workspace globs, per-scaffold package presence and name uniqueness, lockfile hygiene, dev-port collisions, turbo task coverage, and per-adapter invariants (Convex `_generated` stubs + `@types/node`, API port drift). Exits 0 (healthy — warnings allowed) or 5; `--json` emits structured results on pure stdout. _(Documented retroactively — #16 shipped in 0.3.0 without a changeset.)_

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
