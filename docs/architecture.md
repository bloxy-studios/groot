# groot architecture

> Status: normative design for v0.2. The repository infrastructure (Phase 0) is live; the engine described here is being built against this document. Command surface details live in [cli-spec.md](./cli-spec.md); per-generator facts live in [scaffold-flows.md](./scaffold-flows.md).

## Design philosophy

groot's core bet: **orchestrate official generators instead of vendoring templates.**

Scaffolding CLIs face a fork in the road:

| Strategy | Examples | Strength | Weakness |
| --- | --- | --- | --- |
| **Vendored templates** (ship your own files) | create-better-t-stack (~daily releases to keep current), create-t3-turbo (template repo; README already trails upstream majors) | Deterministic output | Rots without industrial upkeep — every upstream release is your maintenance burden |
| **Live official generators** (run `create-next-app` et al. at scaffold time) | groot | Output never rots — you always get today's framework | N moving targets: upstream flags change under you |

groot chooses live generators and mitigates the moving-target problem three ways:

1. **Pinned generator majors** — groot invokes `bunx create-next-app@16`, `bunx sv@0.16`, etc. Bumping a generator major is an explicit, tested, changelogged groot release.
2. **Thin flag adapters** — each generator's invocation lives in one small adapter module that can be updated independently when upstream changes flags.
3. **A written contract per generator** — [scaffold-flows.md](./scaffold-flows.md) records every verified flag, output shape, and monorepo caveat, with sources and a verification date. Drift is detected by re-verifying that document, not by archaeology.

Two deliberate exceptions where groot writes files directly instead of shelling out:

- **Elysia** — `bun create elysia` resolves to a community-owned package whose template diverges from Elysia's own documented setup (no `dev` script). groot writes the four files from Elysia's official manual-setup docs instead.
- **Convex** — there is no offline official generator; groot writes the `packages/backend` package (schema, config, scripts) and runs `bunx convex codegen --init` to materialize `convex/_generated` **without requiring login**. The interactive `convex dev --until-success` (login + deployment provisioning) is deferred to the user's first run, surfaced as a clearly printed next step.

## Pipeline

`groot init` is a strict five-stage pipeline. Every stage either succeeds completely or fails the run with a precise error; `--dry-run` prints the resolved plan (stages 1–2) without touching disk.

```
┌─────────────┐   ┌────────────┐   ┌──────────────┐   ┌───────────┐   ┌──────────┐
│ 1. RESOLVE  │ → │ 2. PREFLIGHT│ → │ 3. GENERATE  │ → │ 4. STITCH │ → │ 5. VERIFY│
│ prompts/flags│   │ env checks │   │ run official │   │ patch into│   │ install, │
│ → plan      │   │ dir policy │   │ generators   │   │ one       │   │ typecheck,│
│             │   │            │   │              │   │ workspace │   │ report   │
└─────────────┘   └────────────┘   └──────────────┘   └───────────┘   └──────────┘
```

### 1. Resolve

Merge CLI flags, interactive prompt answers (clack), and defaults into an immutable **plan**: the target directory, the selected scaffold for each slot (web / mobile / api / backend), assigned ports, and package names. The plan is serializable — `--dry-run --json` prints it for agents and CI.

### 2. Preflight

- Bun present and ≥ minimum version; git present (unless `--no-git`).
- Network reachable (generators download from npm/GitHub).
- Target directory policy (`--dir-conflict`): `error` (default), `merge`, or `increment` (my-app → my-app-1). No official generator has a consistent non-empty-dir story — groot enforces one policy *before* any generator runs.

### 3. Generate

Run each selected generator with its **silence flags** (non-interactive, no git init, no install — see the adapter contract below). Order: trunk first (`create-turbo` plants the workspace, then groot removes the example apps it doesn't need), then branches (web → mobile → api → backend). Each generator writes into its final location (`apps/web`, `apps/mobile`, `apps/api`, `packages/backend`).

### 4. Stitch

The stitch stage is groot's real value — the deterministic patch set that turns N independent scaffolds into one workspace. Canonical reference: the diff between raw generator output and the equivalent app inside Turborepo's own `basic`/`kitchen-sink` examples.

Stitch operations (each implemented as a pure, unit-tested transform):

| Operation | Detail |
| --- | --- |
| Workspace globs | Root `package.json` gets `"workspaces": ["apps/*", "packages/*"]`, `"packageManager": "bun@<pinned>"` |
| Package naming | Apps keep bare names (`web`, `mobile`, `api`); shared packages use `@repo/*` (`@repo/backend`, `@repo/typescript-config`) |
| Lockfile hygiene | Delete any per-app lockfiles generators left behind; exactly one root `bun.lock` |
| Git hygiene | Merge per-app `.gitignore`s into coherent ignores; single `git init` + initial commit at the end (unless `--no-git`) |
| Port allocation | Deterministic dev ports written into each app (flag or source, per adapter) — see table below |
| turbo.json | Root tasks (`dev`, `build`, `lint`, `check-types`) with correct `outputs` per framework |
| Shared TS config | `packages/typescript-config` with per-framework extends, apps' `tsconfig.json` rewired to extend it |
| Env plumbing | `.env.example` entries per scaffold (e.g. `NEXT_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_URL`) |
| groot.json | Manifest recording what was scaffolded, by which generator version — the contract for `groot add`/`doctor` |

### 5. Verify

`bun install` at the root (unless `--no-install`), then `tsc --noEmit`-level checks per package via turbo, then a summary report with next steps (including the deferred `convex dev` login step when Convex was selected). This stage is also exposed standalone as `groot doctor`.

## Port allocation

Next.js, Elysia, and Hono all default to port 3000 — the #1 papercut of multi-app workspaces. groot assigns deterministic ports at scaffold time:

| App | Port | Mechanism |
| --- | --- | --- |
| `apps/web` (Next.js) | 3000 | `next dev` default (kept) |
| `apps/web` (SvelteKit) | 5173 | Vite default (kept) |
| `apps/api` (Elysia / Hono) | 3001 | Written into source (`.listen(3001)` / `export default { port: 3001, fetch }`) — these templates have no port flag |
| `apps/mobile` (Expo / Metro) | 8081 | Metro default (kept) |
| `packages/backend` (Convex) | — | Cloud dev deployment; no local port |

## Workspace conventions (what groot outputs)

- **Bun end-to-end**: `bun install`, `bun run dev` (→ `turbo run dev`), single `bun.lock`.
- **`@repo/*` namespace** for shared packages, `workspace:*` protocol for internal deps — matching Turborepo's official examples so upstream docs stay applicable.
- **Convex consumption**: apps depend on `"@repo/backend": "workspace:*"` and import `@repo/backend/convex/_generated/api` (deep imports; the backend package intentionally has no `exports` map). `convex/_generated` is committed, per Convex's own recommendation.
- **Expo in workspaces**: Expo ≥ SDK 52 auto-configures Metro for monorepos — groot does *not* write legacy `metro.config.js` workspace hacks.

## Adapter contract

Every scaffold is described by one adapter module implementing:

```ts
interface ScaffoldAdapter {
  id: string;                    // "next", "sveltekit", "expo", "elysia", "hono", "convex"
  slot: "web" | "mobile" | "api" | "backend";
  /** Exact generator invocation with pinned major + silence flags, or null when groot writes files directly. */
  command(plan: Plan): GeneratorCommand | null;
  /** Files groot writes itself (Elysia, Convex — and small overlays for others). */
  writeFiles?(plan: Plan): FileSpec[];
  /** Pure post-generation transforms (rename package, rewire tsconfig, set port…). */
  patches(plan: Plan): Patch[];
  /** Doctor checks specific to this scaffold. */
  doctor?(workspace: Workspace): DoctorCheck[];
}
```

Rules for adapter authors:

1. The generator invocation must be fully non-interactive and must **not** git-init, install, or write outside its target directory. Suppression flags per generator are documented in [scaffold-flows.md](./scaffold-flows.md).
2. Patches must be pure functions of (generated tree, plan) — no network, no ambient state — so they're unit-testable without running generators.
3. Update `scaffold-flows.md` (flags, caveats, sources, verification date) in the same PR as any adapter change.

## Failure semantics

- Stages 1–2 fail before anything is written.
- If a generator fails in stage 3 and groot created the target directory, groot removes the directory (default) — or leaves it and prints what completed when `--keep-failed` is set.
- Stage 4–5 failures leave the tree in place with a precise report; every stitch operation is idempotent, so re-running is safe.
- Exit codes are part of the CLI contract — see [cli-spec.md](./cli-spec.md).

## Security posture

- groot runs well-known official generators fetched through bun's registry client; it never downloads or executes ad-hoc remote scripts.
- Generator majors are pinned; bumping them is a reviewed, changelogged change.
- groot's own supply chain: SHA-pinned CI actions, npm provenance, checksum-verified binary installers (see [SECURITY.md](../SECURITY.md)).
