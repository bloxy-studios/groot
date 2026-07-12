# Scaffold flows — verified generator reference

> **Last verified: 2026-07-10.** Every adapter change must re-verify its section against upstream and update this date, the facts, and the sources. This document is the ground truth groot's adapters are written against.
>
> Drift is watched automatically: [`e2e.yml`](../.github/workflows/e2e.yml) re-runs the real generators weekly (behavior), and [`drift.yml`](../.github/workflows/drift.yml) re-checks every pinned series and this document's age (pins & docs) — see the [maintainer runbook](./maintainers.md#upstream-drift-watch).

Version snapshot at verification: create-turbo 2.10.4 · Next.js 16.2.10 · sv 0.16.2 (SvelteKit 2.63 / Svelte 5.56 / Vite 8) · create-expo-app 4.0.0 (Expo SDK 57) · elysia 1.4.29 · create-hono 0.19.4 (hono 4.12.28) · convex 1.42.1.

## Summary matrix

| Scaffold | groot invocation (pinned major) | Git-inits? | Auto-installs? | Non-empty dir behavior |
| --- | --- | --- | --- | --- |
| Turborepo (trunk) | `bunx create-turbo@2 <dir> -m bun --skip-install --no-git` | yes → suppressed | yes → suppressed | assume fresh dir required |
| Next.js | `bunx create-next-app@16 … --disable-git --skip-install` | skips inside existing repo; forced off anyway | yes → suppressed | **refuses** ("could conflict") |
| SvelteKit | `bunx sv@0.16 create … --no-install --no-dir-check` | never | only with `--install` | refuses unless `--no-dir-check` |
| TanStack Start | `bunx @tanstack/cli@0.69 create <name> --framework React --package-manager bun --no-git --no-install --no-examples --no-toolchain --no-intent --yes` | `--no-git` | `--no-install` | refuses unless `--force` |
| Astro | `bunx create-astro@5 <name> --template minimal --no-install --no-git --no-ai --skip-houston --yes` | `--no-git` | `--no-install` | ⚠️ silently redirects to a random dir under `--yes` (see §11) |
| React Router | `bunx create-react-router@8 <name> --package-manager bun --no-git-init --no-install --no-agent-skills --yes` | `--no-git-init` | `--no-install` | hard-fails on collisions without `--overwrite` |
| Expo | `bunx create-expo-app@4 … --no-install` | no flag exists (see caveats) | yes → suppressed | (unverified) |
| Tauri | `bunx create-tauri-app@4 <name> --template react-ts --manager bun --identifier <id> --yes` | never | never | refuses unless `--force` |
| Electron | `bunx @quick-start/create-electron@1 <name> --template react-ts --skip` | never | never | overwrite prompt nulled by `--skip` |
| Elysia | *(none — groot writes files directly)* | — | — | — |
| Hono | `bunx create-hono@0.19 … --template bun` | never | only with `-i` | **interactive confirm, no bypass** → must target fresh dir |
| Convex | *(files written directly, incl. vendored `_generated` stubs)* | — | — | — |

## 1. Turborepo trunk — `create-turbo`

```sh
bunx create-turbo@2 my-repo -m bun --skip-install --no-git
```

- Flags (from CLI source): `-m/--package-manager <npm|yarn|pnpm|bun>`, `--skip-install`, `--no-git`, `--skip-transforms`, `--turbo-version <v>`, `-e/--example <name|github-url>`, `-p/--example-path`.
- ⚠️ `--skip-transforms` conflicts with `-m` (transforms are what convert the pnpm-flavored example to bun). Never combine.
- Generates (basic example): `apps/web` + `apps/docs` (Next.js), `packages/ui`, `packages/eslint-config`, `packages/typescript-config`, root `turbo.json` (v2 `"tasks"` key), root `package.json`. The bun transform replaces `pnpm-workspace.yaml` with a root `workspaces` array + `packageManager: "bun@…"`.
- Git init runs **last** (after transforms/install) so suppression is clean.
- groot post-patch: **remove** the example `apps/web`, `apps/docs`, `packages/ui`, `packages/eslint-config` (groot's selected scaffolds replace them; `packages/typescript-config` is kept and extended), reset root README, write `groot.json`.
- Sources: <https://github.com/vercel/turborepo/blob/main/packages/create-turbo/src/cli.ts>, <https://github.com/vercel/turborepo/tree/main/examples/basic>, <https://turborepo.com/docs/reference/configuration>.

## 2. Web: Next.js — `create-next-app`

```sh
bunx create-next-app@16 apps/web \
  --ts --tailwind --eslint --app --src-dir --turbopack \
  --import-alias "@/*" --use-bun --skip-install --disable-git --yes
```

- Current flag set (v16.2): `--ts/--js`, `--tailwind` (negate `--no-tailwind`), **linter trio `--eslint` | `--biome` | `--no-linter`** (the old `--no-eslint` world is gone), `--react-compiler`, `--app`, `--api` (route-handlers-only), `--src-dir/--no-src-dir`, `--turbopack` (default on), `--import-alias <alias>`, `--empty`, `--use-bun` (et al.), `-e/--example`, `--skip-install`, `--disable-git`, `--yes`, `--reset-preferences`, `--agents-md/--no-agents-md` (AGENTS.md + CLAUDE.md, **default on**).
- ⚠️ `--yes` reuses *saved user preferences* — CI/agents must pass every flag explicitly (groot does).
- Refuses non-empty target dirs; skips git init when already inside a git repo (groot passes `--disable-git` anyway).
- Generates `app/` router + Tailwind v4 (`postcss.config.mjs`), `next.config.ts`, `tsconfig.json`, own `.gitignore`, `AGENTS.md`/`CLAUDE.md`.
- groot post-patch: rewire `tsconfig.json` to extend `@repo/typescript-config/nextjs.json`, keep port 3000, remove per-app lockfile if any, fold `.gitignore`.
- Sources: <https://nextjs.org/docs/app/api-reference/cli/create-next-app>, <https://github.com/vercel/next.js/blob/canary/packages/create-next-app/index.ts>, <https://github.com/vercel/next.js/blob/canary/packages/create-next-app/helpers/git.ts>.

## 3. Web: SvelteKit — `sv create`

`create-svelte` is deprecated; **`sv` is the official CLI** (merged create-svelte + svelte-add).

```sh
bunx sv@0.16 create apps/web --template minimal --types ts --no-add-ons --no-install --no-dir-check
```

- Flags: `--template <minimal|demo|library>`, `--types <ts|jsdoc>` (or `--no-types`, not recommended), `--add <add-ons…>` / `--no-add-ons`, `--install <npm|pnpm|yarn|bun|deno>` / `--no-install`, `--no-dir-check`, `--from-playground <url>`.
- Never git-inits. Writes its own `.gitignore` and `.npmrc`.
- ⚠️ The generated `prepare` script (`svelte-kit sync || echo ''`) fires during root `bun install` — harmless, but expect it in install output.
- Generates: `src/{app.html,app.d.ts,lib/,routes/}`, `vite.config.ts`, `tsconfig.json`. Deps: `@sveltejs/kit ^2.63`, `svelte ^5.56`, `vite ^8`, `@sveltejs/adapter-auto ^7`.
- ⚠️ **No `svelte.config.js`** (verified 2026-07-10 against sv 0.16.2 output): SvelteKit config now lives inside `vite.config.ts` as `sveltekit({ adapter, compilerOptions })` plugin options — adapters and doctor checks must look there.
- groot post-patch: add `check` / `check-types` scripts (mirroring Turborepo's with-svelte example), keep Vite port 5173, fold `.gitignore`/`.npmrc`.
- Sources: <https://svelte.dev/docs/cli/sv-create>, <https://www.npmjs.com/package/sv>, <https://www.npmjs.com/package/create-svelte> (deprecation notice), <https://github.com/vercel/turborepo/tree/main/examples/with-svelte>.

## 4. Mobile: Expo — `create-expo-app`

```sh
bunx create-expo-app@4 apps/mobile --template default@sdk-57 --no-install --yes
```

- Flags: `--yes`, `--no-install`, `--template <name>[@<tag>]`, `--example <name>`, `--no-agents-md`, `--version`. Templates: `default` (Expo Router + TS — groot's choice), `blank`, `blank-typescript`, `tabs`, `bare-minimum`.
- ⚠️ **SDK transition gotcha:** during the SDK 57 transition, omitting `--template` yields an SDK **54** project. groot always pins the template tag explicitly (`default@sdk-57`).
- ⚠️ **No git-suppression flag exists.** `create-expo-app` git-inits its output whenever it doesn't detect an enclosing repo — and during `groot init` the root repo doesn't exist yet (root `git init` runs in the verify stage, after generation), so a nested `apps/mobile/.git` appeared every time (fixed in v1.0.1). The engine now scrubs any generator-created `.git` immediately after each scaffold grows ([architecture.md#3-generate](./architecture.md#3-generate)); the doctor check remains as a tripwire for workspaces grown earlier.
- Monorepos: Expo has **first-class bun-workspaces support**; since SDK 52 Metro **auto-configures** for monorepos — do *not* write legacy `metro.config.js` workspace hacks (`watchFolders`, `nodeModulesPath`…). Shared packages consumed as `"<pkg>": "*"`.
- Metro dev server port: 8081 (kept).
- Sources: <https://docs.expo.dev/more/create-expo/>, <https://docs.expo.dev/guides/monorepos/>, <https://www.npmjs.com/package/expo>.

## 5. API: Elysia — files written directly (no generator)

`bun create elysia` resolves to the npm package `create-elysia`, which is **community-owned** (not an elysiajs org package), interactive-prompt-based, and diverges from Elysia's own docs (its template lacks the documented `dev` script). groot therefore writes the four files from Elysia's official manual setup:

```
apps/api/
├── src/index.ts       # new Elysia().get("/", …).listen(3001)  ← port patched from default 3000
├── package.json       # dev: bun --watch src/index.ts · build: bun build … · start · test: bun test
├── tsconfig.json      # strict: true
└── README.md
```

Deps: `elysia@^1.4` + `@types/bun`. Scripts per Elysia's docs: `dev: bun --watch src/index.ts`, `build: bun build src/index.ts --target bun --outdir ./dist`, `start: NODE_ENV=production bun dist/index.js`, `test: bun test`.

- Sources: <https://elysiajs.com/quick-start.html>, <https://www.npmjs.com/package/create-elysia> (ownership), <https://bun.com/docs/runtime/templating/create> (`bun create x` ≡ `bunx create-x`).

## 6. API: Hono — `create-hono`

```sh
bunx create-hono@0.19 apps/api --template bun --pm bun
```

- Flags: `-t/--template <bun|nodejs|cloudflare-workers|…>`, `-i/--install` (install is **opt-in**), `-p/--pm <bun|…>`, `-o/--offline` (giget cache).
- ⚠️ **The install confirmation has no negative flag** (verified 2026-07-10 on 0.19.4): without `-i`, create-hono still *prompts* "Do you want to install project dependencies?", and an unanswered prompt (closed stdin) aborts the entire scaffold with "User force closed the prompt" — no files written. groot pre-answers `n` via stdin.
- Templates are fetched from `honojs/starter` pinned to a tag matching create-hono's own major.minor — deterministic per CLI version. Sets `package.json#name` to the directory basename.
- Never git-inits. ⚠️ **Non-empty target → interactive confirm with no bypass flag** — groot must always target a freshly created directory.
- Generates: `src/index.ts` (`export default app`), `package.json` (`dev: bun run --hot src/index.ts`, `hono ^4.12`), `tsconfig.json`.
- groot post-patch: Bun serves default-export apps on port 3000 → rewrite to `export default { port: 3001, fetch: app.fetch }`; add `build`/`start` scripts mirroring the Elysia layout.
- Sources: <https://github.com/honojs/create-hono>, <https://github.com/honojs/starter/tree/main/templates/bun>.

## 7. Backend: Convex — files written directly, `_generated` stubs vendored

No fully-offline official generator exists (`create-convex` is a degit template copier oriented at full-stack presets). groot writes `packages/backend` directly, modeled on Convex's own reference monorepo (`get-convex/turbo-expo-nextjs-clerk-convex-monorepo`):

```
packages/backend/
├── convex/
│   ├── schema.ts          # starter schema (messages table)
│   ├── messages.ts        # starter query + mutation matching the schema
│   ├── tsconfig.json      # vendored from get-convex/templates
│   └── _generated/        # vendored standard stubs — COMMITTED (official recommendation)
├── package.json           # @repo/backend · dev: convex dev · setup: convex dev --until-success · typecheck
└── .env.example           # CONVEX_DEPLOYMENT / CONVEX_URL placeholders
```

- ⚠️ **`convex codegen` is NOT offline-usable in current releases** (verified 2026-07-10 on convex 1.42.1): `bunx convex codegen --init` in a fresh package fails with *"No CONVEX_DEPLOYMENT set, run `npx convex dev` to configure a Convex project"*. The older maintainer statements about credential-free codegen (get-convex/convex-js#81) no longer hold for new projects.
- **groot copies the official templates' strategy instead**: get-convex/templates ships the standard `convex/_generated` stubs (`api.d.ts`, `api.js`, `dataModel.d.ts`, `server.d.ts`, `server.js`) checked in, so the package typechecks before any login. groot vendors those stubs (`src/adapters/convex-generated-stubs.ts`, `api.d.ts` adapted to the starter `messages.ts` module); the first `convex dev` run regenerates them against the live deployment.
- ⚠️ **The vendored `convex/tsconfig.json` declares `"types": ["node"]`** — the generated package.json must therefore carry `@types/node` (pin tracks the upstream template), or `convex dev`'s built-in typecheck fails with TS2688. Caught in a live v0.2.0 run; the E2E now typechecks scaffolded packages, not just installs them.
- ⚠️ **Known upstream quirk (verified 2026-07-10, cosmetic)**: `convex dev`'s optional "Set up Convex AI files?" step installs agent skills via `npx`, which trips npm's `devEngines` guard inside the bun-declared workspace (`EBADDEVENGINES: required { name: 'bun' }`). The guard is working as intended; Convex prints a manual retry command and continues — deployment provisioning and `.env.local` are unaffected.
- The one unavoidable interactive step — `bunx convex dev --until-success` (login, deployment provisioning, `.env.local`) — is **never run by groot**; it's printed as the first "next step".
- Consumption pattern: apps depend on `"@repo/backend": "workspace:*"` and deep-import `@repo/backend/convex/_generated/api` (no `exports` map — deliberate, matching the reference repo). Frontends receive the Convex URL via `.env` plumbing, named per framework: `NEXT_PUBLIC_CONVEX_URL` (Next), `PUBLIC_CONVEX_URL` (SvelteKit, Astro), `VITE_CONVEX_URL` (TanStack Start, React Router), `EXPO_PUBLIC_CONVEX_URL` (Expo).
- Sources: <https://docs.convex.dev/cli/reference/codegen>, <https://docs.convex.dev/cli>, <https://github.com/get-convex/templates> (stub strategy), <https://github.com/get-convex/turbo-expo-nextjs-clerk-convex-monorepo>, <https://docs.convex.dev/production/project-configuration>.

## 8. Desktop: Tauri — `create-tauri-app`

```sh
bunx create-tauri-app@4 desktop --template react-ts --manager bun --identifier com.<workspace>.desktop --yes
```

- Flags: `-t/--template` (`react-ts` pinned — TS + React frontend), `-m/--manager` (`bun` is a first-class option), `--identifier` (reverse-domain bundle id; the CLI warns on its `com.tauri.dev` default, so groot derives one from the workspace name), `-y/--yes` (skip remaining prompts), `-f/--force`, `--tauri-version`. Never installs, never git-inits.
- ⚠️ **The positional is a NAME, not a path** — the generator derives the app and crate names from it. groot therefore spawns from the scaffold's *parent* directory (`apps/`) with the bare directory name, instead of passing `apps/desktop` from the workspace root.
- **Port 1420 is the template's own contract**: the generated `vite.config` pins `server.port: 1420` with `strictPort: true`, and `src-tauri/tauri.conf.json` points `build.devUrl` at the same port. Unique in groot's matrix → kept, no rewrite.
- **Rust is a dev-time dependency, not a scaffold-time one**: generation is pure npm; `bun install` works without cargo. `tauri dev`/`tauri build` need Rust (plus webkit2gtk on Linux) — groot prints a rustup next-step and `doctor` warns (never fails) when cargo is absent.
- Wrap-the-existing-web-app mode (`bunx @tauri-apps/cli init --ci` pointed at `apps/web`) is a distinct, officially supported shape — deferred to the add-on engine ([expansion.md](./expansion.md#desktop-slot-candidates-new-slot), [roadmap v1.4](./roadmap.md)).
- Sources: <https://v2.tauri.app/start/create-project/>, <https://v2.tauri.app/reference/cli/>, <https://github.com/tauri-apps/create-tauri-app>.

## 9. Desktop: Electron — `@quick-start/create-electron` (electron-vite)

```sh
bunx @quick-start/create-electron@1 desktop --template react-ts --skip
```

- **Why this generator**: electron-vite's scaffolder is the de-facto standard for Electron + Vite + TS. Electron Forge's own `create-electron-app` force-installs dependencies (npm/yarn only, no skip flag) and marks its Vite template experimental — unsuitable for groot's scaffold-dry model ([expansion.md](./expansion.md#desktop-slot-candidates-new-slot)).
- Flags: `-t/--template` (`react-ts` pinned; the `-ts` suffix nulls the TypeScript prompt) and `--skip` (nulls the remaining prompts: overwrite, auto-update, mirror). Never installs, never git-inits — prints next steps only.
- ⚠️ **The positional is a NAME, not a path** — same contract as create-tauri-app: groot spawns from the scaffold's parent directory (`apps/`) with the bare directory name.
- **No declared dev port**: the renderer dev server is plain Vite (non-strict) and electron-vite launches Electron with whatever URL it resolved — self-wiring, so groot neither promises nor manages a port (unlike Tauri's contractual strictPort 1420).
- ⚠️ **Bun lifecycle nuance (verified 2026-07-12, bun 1.3.14)**: the `electron` package downloads its runtime binary in a postinstall script, and bun only runs dependency lifecycle scripts for trusted packages — **electron is NOT on bun's default-trusted list** (the flagship E2E's real `bun install` proved it: runtime missing without a grant). The stitch stage writes `trustedDependencies: ["electron"]` into the workspace root package.json before verify's install — empirically honored for workspace-member dependencies — and verify keeps a `bun pm trust electron` fallback for degraded workspaces. Note bun treats an explicit `trustedDependencies` as replacing its default allowlist; packages a user later adds that need postinstalls belong in the same array.
- ⚠️ **Bun 1.3 isolated-layout nuance**: packages live in the `node_modules/.bun` store with symlinks in the *declaring* workspace member — there is **no top-level `node_modules/electron`**. Anything checking electron's install state must resolve from the app directory (groot's doctor/verify use node resolution from `apps/desktop`), not from a hardcoded root path.
- Build output: `out/` (main/preload/renderer) — added to turbo's `build.outputs`; electron-builder's installers land in `dist/` (not cached).
- Sources: <https://electron-vite.org/guide/>, <https://www.npmjs.com/package/@quick-start/create-electron>, <https://bun.com/docs/pm/lifecycle>.

## 10. Web: TanStack Start — `@tanstack/cli` (`tanstack create`)

```sh
bunx @tanstack/cli@0.69 create web --framework React --package-manager bun --no-git --no-install --no-examples --no-toolchain --no-intent --yes
```

- **Flags (verified 2026-07-12 against the published 0.69.5 source)**: `--framework <React|Solid>` (display names from the framework definitions), `--package-manager bun` (first-class value), `--no-git`, `--no-install`, `--no-examples` (skip demo pages), `--no-toolchain` (skip the eslint/biome overlay — the workspace root owns linting), `--no-intent` (skip TanStack Intent agent files; groot's own agent artifacts arrive with roadmap v1.3), `-y/--yes` (accept remaining defaults), plus `--target-dir`, `-f/--force`, `--json`, `--add-ons`. The deprecated `--tailwind`/`--no-tailwind` are compatibility no-ops — Tailwind is always enabled.
- ⚠️ **The positional is a NAME, not a path** — same contract as create-tauri-app/create-electron: groot spawns from the scaffold's parent with the bare directory name.
- **Port 3000 lives in the dev script** (`"dev": "vite dev --port 3000"` in the template's package.json), not in vite.config — same default as Next.js. Single-web workspaces are clean; `groot add tanstack-start --path apps/<name>` next to a Next app trips the standard port-collision warning, and doctor tracks the dev-script/manifest agreement.
- **Build is plain `vite build` → `dist/`** — the 1.x template has no Nitro/Vinxi (verified: no such deps in the template package.json); `dist/**` is already in turbo's outputs.
- Template ships TS-first (typescript ^6, vite ^8, react 19), Tailwind, file-based routing with the Start plugin; the scaffolded package.json `name` field is empty — stitch names it from the directory.
- The CLI is 0.x and fast-moving — pinned to the minor (`@tanstack/cli@0.69`), the sv@0.16 precedent; the drift watch tracks the series automatically.
- Sources: <https://tanstack.com/start/latest/docs/framework/react/quick-start>, <https://www.npmjs.com/package/@tanstack/cli> (dist/cli.js option table), <https://www.npmjs.com/package/@tanstack/create> (react framework template).

## 11. Web: Astro — `create-astro`

```sh
bunx create-astro@5 web --template minimal --no-install --no-git --no-ai --skip-houston --yes
```

- **Flags (verified 2026-07-12 against the published 5.2.2 source)**: `--template <name|gh-repo>`, `--ref`, `--install/--no-install`, `--git/--no-git`, `--no-ai` (skip AI agent config files — groot's own agent artifacts arrive with roadmap v1.3), `--skip-houston` (skip the mascot animation), `-y/--yes`, `-n/--no`, `--dry-run`, `--add`, `--fancy`. Node >= 22.12 required by the package.
- ⚠️ **Non-empty-target gotcha (verified in source)**: with `--yes`, a non-empty target directory is silently *ignored* — create-astro scaffolds into a randomly generated project name instead (`generateProjectName()`). groot's generate stage guarantees a fresh destination, which makes this unreachable — but never invoke this generator outside that guarantee. (A dir containing only `.git`/`.gitignore`-class entries counts as empty per its safe list.)
- **The positional doubles as the project-name source** — bare names pass `toValidName` untouched; a path like `apps/web` would become the package name `apps-web`. groot spawns from the scaffold's parent with the bare basename.
- Templates are fetched via **giget from the withastro/astro examples** at scaffold time (network to GitHub, not npm); `minimal` is pinned. TS-strict by default in 5.x — the old `--typescript` flag no longer exists.
- **Port 4321** is `astro dev`'s built-in default (no config entry, no dev-script flag) — the only unique web port in the matrix; nothing to rewrite or drift-check.
- Build: `astro build` → `dist/` (already in turbo's outputs).
- Sources: <https://docs.astro.build/en/install-and-setup/>, <https://www.npmjs.com/package/create-astro> (dist/index.js flag table + project-name action), <https://docs.astro.build/en/guides/environment-variables/> (PUBLIC_ prefix).

## 12. Web: React Router (framework mode) — `create-react-router`

```sh
bunx create-react-router@8 web --package-manager bun --no-git-init --no-install --no-agent-skills --yes
```

- **Flags (verified 2026-07-12 against the published 8.2.0 source)**: `--yes`, `--git-init/--no-git-init`, `--install/--no-install`, `--package-manager <npm|pnpm|yarn|bun|deno>`, `--agent-skills/--no-agent-skills`, `--template <gh-url-or-shorthand>`, `--overwrite`, `--react-router-version/-v`, `--no-color`, `--no-motion`, `--show-install-output`, `--token`, `--debug`.
- ⚠️ **v8.2 added an agent-skills step**: the CLI ships React Router's own SKILL.md + reference docs and offers to copy them into the project. groot passes `--no-agent-skills` — the same policy as TanStack's `--no-intent` and Astro's `--no-ai`: groot's own agent-era artifacts arrive with roadmap v1.3 and per-scaffold agent files would collide.
- **The default template is fetched from GitHub at scaffold time** (`remix-run/react-router-templates/tree/main/default`): TS + Tailwind + SSR, plus a Dockerfile (kept as-is). In non-TTY runs the CLI auto-forces `--yes`; pre-existing file collisions hard-fail without `--overwrite` — groot's fresh-destination guarantee makes that unreachable.
- **The positional doubles as the project-name source** (`toValidProjectName`, same shape as create-astro) — groot spawns from the scaffold's parent with the bare basename.
- **Port 5173** is the Vite default (no dev-script flag, no config entry) — shared with SvelteKit; same-slot alternatives share ports (the elysia/hono precedent), and `add --path` coexistence rides the collision warning.
- Build: `react-router build` → `build/` (client + server; the template's serve script points at `build/server/index.js`) — added to turbo's outputs. Typecheck: `react-router typegen && tsc`.
- Sources: <https://reactrouter.com/start/framework/installation>, <https://www.npmjs.com/package/create-react-router> (dist/cli.js option table), <https://github.com/remix-run/react-router-templates/tree/main/default>.

## Stitching reference

The canonical "what does stitched output look like" spec is the diff between raw generator output and the same app inside Turborepo's official examples (`basic`, `with-svelte`, `kitchen-sink`): package renames, `@repo/*` deps with `workspace:*`, shared `typescript-config` extends, per-app ports in dev scripts, no nested lockfiles. See [architecture.md](./architecture.md#4-stitch) for the full operation list.

## Prior-art notes (why groot works this way)

- **create-better-t-stack**: vendored Handlebars templates + near-daily releases to fight drift. groot copies its *automation contract* (`--yes`, `--dry-run`, explicit dir-conflict policy, JSON plan output) but not its template strategy.
- **create-t3-turbo**: a template repo consumed via `create-turbo -e` — already trailing upstream majors at verification time; demonstrates template rot.
- Both confirm: generators' monorepo-hostile side effects (git init, auto-install, nested lockfiles, port collisions) are the real problem groot's stitch stage solves.
