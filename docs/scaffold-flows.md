# Scaffold flows — verified generator reference

> **Last verified: 2026-07-10.** Every adapter change must re-verify its section against upstream and update this date, the facts, and the sources. This document is the ground truth groot's adapters are written against.

Version snapshot at verification: create-turbo 2.10.4 · Next.js 16.2.10 · sv 0.16.2 (SvelteKit 2.63 / Svelte 5.56 / Vite 8) · create-expo-app 4.0.0 (Expo SDK 57) · elysia 1.4.29 · create-hono 0.19.4 (hono 4.12.28) · convex 1.42.1.

## Summary matrix

| Scaffold | groot invocation (pinned major) | Git-inits? | Auto-installs? | Non-empty dir behavior |
| --- | --- | --- | --- | --- |
| Turborepo (trunk) | `bunx create-turbo@2 <dir> -m bun --skip-install --no-git` | yes → suppressed | yes → suppressed | assume fresh dir required |
| Next.js | `bunx create-next-app@16 … --disable-git --skip-install` | skips inside existing repo; forced off anyway | yes → suppressed | **refuses** ("could conflict") |
| SvelteKit | `bunx sv@0.16 create … --no-install --no-dir-check` | never | only with `--install` | refuses unless `--no-dir-check` |
| Expo | `bunx create-expo-app@4 … --no-install` | no flag exists (see caveats) | yes → suppressed | (unverified) |
| Elysia | *(none — groot writes files directly)* | — | — | — |
| Hono | `bunx create-hono@0.19 … --template bun` | never | only with `-i` | **interactive confirm, no bypass** → must target fresh dir |
| Convex | *(files written directly + `bunx convex codegen --init`)* | — | — | — |

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
- Generates: `src/{app.html,app.d.ts,lib/,routes/}`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`. Deps: `@sveltejs/kit ^2.63`, `svelte ^5.56`, `vite ^8`, `@sveltejs/adapter-auto ^7`.
- groot post-patch: add `check` / `check-types` scripts (mirroring Turborepo's with-svelte example), keep Vite port 5173, fold `.gitignore`/`.npmrc`.
- Sources: <https://svelte.dev/docs/cli/sv-create>, <https://www.npmjs.com/package/sv>, <https://www.npmjs.com/package/create-svelte> (deprecation notice), <https://github.com/vercel/turborepo/tree/main/examples/with-svelte>.

## 4. Mobile: Expo — `create-expo-app`

```sh
bunx create-expo-app@4 apps/mobile --template default@sdk-57 --no-install --yes
```

- Flags: `--yes`, `--no-install`, `--template <name>[@<tag>]`, `--example <name>`, `--no-agents-md`, `--version`. Templates: `default` (Expo Router + TS — groot's choice), `blank`, `blank-typescript`, `tabs`, `bare-minimum`.
- ⚠️ **SDK transition gotcha:** during the SDK 57 transition, omitting `--template` yields an SDK **54** project. groot always pins the template tag explicitly (`default@sdk-57`).
- ⚠️ **No git-suppression flag exists.** groot runs Expo *after* the workspace root exists as a git repo (Expo's generator behaves like create-next-app inside an existing repo) and verifies no nested `.git` was created (doctor check).
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
- Templates are fetched from `honojs/starter` pinned to a tag matching create-hono's own major.minor — deterministic per CLI version. Sets `package.json#name` to the directory basename.
- Never git-inits. ⚠️ **Non-empty target → interactive confirm with no bypass flag** — groot must always target a freshly created directory.
- Generates: `src/index.ts` (`export default app`), `package.json` (`dev: bun run --hot src/index.ts`, `hono ^4.12`), `tsconfig.json`.
- groot post-patch: Bun serves default-export apps on port 3000 → rewrite to `export default { port: 3001, fetch: app.fetch }`; add `build`/`start` scripts mirroring the Elysia layout.
- Sources: <https://github.com/honojs/create-hono>, <https://github.com/honojs/starter/tree/main/templates/bun>.

## 7. Backend: Convex — files written directly + offline codegen

No fully-offline official generator exists (`create-convex` is a degit template copier oriented at full-stack presets). groot writes `packages/backend` directly, modeled on Convex's own reference monorepo (`get-convex/turbo-expo-nextjs-clerk-convex-monorepo`):

```
packages/backend/
├── convex/
│   ├── schema.ts          # starter schema
│   ├── README.md          # written by codegen --init
│   ├── tsconfig.json      # written by codegen --init
│   └── _generated/        # written by codegen — COMMITTED (official recommendation)
├── package.json           # @repo/backend · dev: convex dev · setup: convex dev --until-success · typecheck
└── .env.example           # CONVEX_DEPLOYMENT / CONVEX_URL placeholders
```

- After writing files, groot runs `bunx convex codegen --init` to materialize `convex/_generated` + `convex/tsconfig.json` **without login** — this works offline as long as the project has no `convex/convex.config.ts` (components); components require a deployment.
- The one unavoidable interactive step — `bunx convex dev --until-success` (login, deployment provisioning, `.env.local`) — is **never run by groot**; it's printed as the first "next step".
- Consumption pattern: apps depend on `"@repo/backend": "workspace:*"` and deep-import `@repo/backend/convex/_generated/api` (no `exports` map — deliberate, matching the reference repo). Frontends receive `NEXT_PUBLIC_CONVEX_URL` / `EXPO_PUBLIC_CONVEX_URL` via `.env` plumbing.
- Sources: <https://docs.convex.dev/cli/reference/codegen>, <https://docs.convex.dev/cli>, <https://github.com/get-convex/turbo-expo-nextjs-clerk-convex-monorepo>, <https://github.com/get-convex/convex-js/issues/81> (offline codegen), <https://docs.convex.dev/production/project-configuration>.

## Stitching reference

The canonical "what does stitched output look like" spec is the diff between raw generator output and the same app inside Turborepo's official examples (`basic`, `with-svelte`, `kitchen-sink`): package renames, `@repo/*` deps with `workspace:*`, shared `typescript-config` extends, per-app ports in dev scripts, no nested lockfiles. See [architecture.md](./architecture.md#4-stitch) for the full operation list.

## Prior-art notes (why groot works this way)

- **create-better-t-stack**: vendored Handlebars templates + near-daily releases to fight drift. groot copies its *automation contract* (`--yes`, `--dry-run`, explicit dir-conflict policy, JSON plan output) but not its template strategy.
- **create-t3-turbo**: a template repo consumed via `create-turbo -e` — already trailing upstream majors at verification time; demonstrates template rot.
- Both confirm: generators' monorepo-hostile side effects (git init, auto-install, nested lockfiles, port collisions) are the real problem groot's stitch stage solves.
