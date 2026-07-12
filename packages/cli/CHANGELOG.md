# create-groot

## 1.5.0

### Minor Changes

- [#64](https://github.com/bloxy-studios/groot/pull/64) [`a1a7712`](https://github.com/bloxy-studios/groot/commit/a1a77122f4c499401891c10a76d37f913ddd5c71) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - React Router (framework mode) joins the web slot — `groot init --web react-router` and `groot add react-router` grow the Remix successor from the official `create-react-router@8` (`--package-manager bun --no-git-init --no-install --no-agent-skills --yes`, verified against the published source). The `--no-agent-skills` flag suppresses v8.2's new step that copies React Router's own SKILL.md into projects — same policy as TanStack's `--no-intent` and Astro's `--no-ai`. Port 5173 (Vite default, shared with SvelteKit per the same-slot precedent), `VITE_CONVEX_URL` env plumbing, `react-router build`'s `build/` output turbo-cached, and doctor checks the framework-mode config. Schema framework enum grows `react-router`; manifest stays version 1.

## 1.4.0

### Minor Changes

- [#62](https://github.com/bloxy-studios/groot/pull/62) [`05c3fe9`](https://github.com/bloxy-studios/groot/commit/05c3fe98ed1d3e4e0f3424ff5988eac8bf853946) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - Astro joins the web slot — `groot init --web astro` and `groot add astro` grow an Astro app from the official `create-astro@5` (`--template minimal --no-install --no-git --no-ai --skip-houston --yes`, all flags verified against the published source). Port 4321 (astro dev's built-in default) is the matrix's only unique web port. Convex env plumbing writes `PUBLIC_CONVEX_URL` (Astro's `import.meta.env.PUBLIC_*` client prefix), `astro build`'s `dist/` is turbo-cached, and doctor checks the astro config. Documented caveat: under `--yes` create-astro silently redirects non-empty targets to a random directory — unreachable behind groot's fresh-destination guarantee, and now written down. Schema framework enum grows `astro`; manifest stays version 1.

## 1.3.0

### Minor Changes

- [#60](https://github.com/bloxy-studios/groot/pull/60) [`9b75def`](https://github.com/bloxy-studios/groot/commit/9b75def43cbf496ff4682aa11a97bc34bf1dd262) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - TanStack Start joins the web slot — `groot init --web tanstack-start` and `groot add tanstack-start` grow a Start app from the official `@tanstack/cli` (`tanstack create`, pinned to the 0.69 minor), fully silenced: `--framework React --package-manager bun --no-git --no-install --no-examples --no-toolchain --no-intent --yes` (all flags verified against the published CLI source). Port 3000 rides the template's own dev script — same default as Next, with the standard collision warning covering `add --path` coexistence — and doctor gains vite-config and dev-script-port checks. The template's plain `vite build` output (`dist/`) is turbo-cached. Schema framework enum grows `tanstack-start`; manifest stays version 1.

## 1.2.0

### Minor Changes

- [#58](https://github.com/bloxy-studios/groot/pull/58) [`8d4e1da`](https://github.com/bloxy-studios/groot/commit/8d4e1daaa91cc941c524c515fae857b77a85f5b0) Thanks [@bloxy-studios](https://github.com/bloxy-studios)! - Electron joins the desktop slot — `groot init --desktop electron` and `groot add electron` grow `apps/desktop` from `@quick-start/create-electron` (electron-vite's scaffolder: react-ts template, `--skip` for full silence; Forge's generator force-installs and can't be silenced). No declared dev port: electron-vite's renderer server is non-strict and self-wiring, unlike Tauri's contractual 1420. Turbo caches electron-vite's `out/` build. Bun lifecycle finding (verified empirically in E2E on bun 1.3.14): electron's runtime-download postinstall is NOT default-trusted — the stitch stage now writes `trustedDependencies: ["electron"]` into the workspace root so `bun install` produces a runnable app, and `groot doctor` detects a blocked runtime with a `bun pm trust electron` fix. Schema framework enum grows `electron`; manifest stays version 1.

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
