# Groot v2 — execution record

> Status: **living handoff record** for the v2 refactor (build brief: [GROOT_V2_BUILD_PROMPT.md](../GROOT_V2_BUILD_PROMPT.md)). Update it at every checkpoint. A fresh session resumes from **Next runnable task**.

## Current state

| Item | Value |
| --- | --- |
| Branch | `refactor/groot-v2-core` (from `main` @ `cfd2eb0`) |
| Last checkpoint commit | _none yet — contracts in progress_ |
| Current gate | **A → B**: baseline recorded; contracts being written |
| Next runnable task | Finish `core/contracts/index.ts` registry + schema generation, typecheck, commit; then foundation utilities (`core/fs`, `core/errors`, `core/ids`, output envelope) |

## Baseline (2026-10-07, before any v2 change)

Environment: macOS (darwin 25.5.0, arm64), Bun **1.4.0** locally (repo `packageManager` and CI pin **1.3.14**), git 2.55.0, gh 2.102.0, Claude Code 2.1.292, codex-cli 0.116.0 (both via cmux shims on PATH).

| Check | Command | Result |
| --- | --- | --- |
| Install | `bun install --frozen-lockfile` | ✅ exit 0 |
| Lint | `bun run lint` (biome ci) | ✅ exit 0 (74 files) |
| Typecheck | `bun run typecheck` | ✅ exit 0 |
| Unit/contract tests | `bun run test` | ✅ 203 pass · 4 skip (E2E gated) · 0 fail |
| Docs/scripts tests | `bun test apps/docs scripts` | ✅ 23 pass · 0 fail |
| Build | `bun run build` | ✅ `packages/cli/dist/groot` (71.0 MB) |
| Binary smoke | `groot --version`; `groot init /tmp/groot-smoke --dry-run --yes [--json]` | ✅ `1.10.0`, v1 manifest JSON |
| Real-generator E2E | `GROOT_E2E=1 bun test generate.e2e` | ⚠️ **3 pass · 1 fail** — *pre-existing*: the flagship + electron scenario timed out (420 s) inside the root `bun install` ("Resolving dependencies", killed with exit 143) under local Bun 1.4.0. The other three scenarios (sveltekit+hono+tanstack, add chain elysia→convex→react-router→tauri→react-native, nuxt+vite+fastify+supabase) pass. CI uses Bun 1.3.14; not a v2 regression. |

Open upstream drift (issue #81): `@tanstack/cli` 0.69→0.71.1, `create-expo-app` 4→5, `sv` 0.16→1.1 — recorded, out of v2 core scope unless trivial.

## Decisions log

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | zod 4.6 is the single source for contracts: runtime validation, TS types (`z.infer`), and generated JSON Schemas (`schemas/v2/`) | Validates untrusted inputs at every boundary; one definition prevents type/schema drift; also what the MCP SDK consumes. Zero transitive deps; +0.5 MB binary (probe) |
| D2 | `groot.json` v2 is a strict superset of v1 (`createdWith`, `conventions`, `scaffolds` keep v1 meaning) plus `project`, `apps`, `capabilities`, `decisions`, `environment`, `verification`, `context`, `policy` | stability.md prescribes "init writes the newest; add/doctor read both"; superset keeps v1-field consumers working |
| D3 | Migration v1→v2 is explicit (`groot migrate`, previewable); `add` on a v1 workspace keeps writing v1 | No silent schema changes |
| D4 | `groot.lock.json` (committed): exact generator versions + integrity, recipe versions + exact deps, owned artifacts with hashes; `.groot/` (gitignored): journals, backups, evidence, tasks, worktrees | Portable intent + reproducibility in git; private/local recovery state out of git |
| D5 | Local state = files (JSONL journal with fsync'd appends + atomic JSON snapshots), not SQLite | Small volumes per project; append+replay is the recovery model; human/agent-inspectable; no WAL/locking surprises; revisit if task volume needs queries |
| D6 | New exit codes for v2 surfaces only: 6 conflict, 7 blocked, 8 locked (v1 table 0/1/2/3/4/5/130 unchanged) | Agents need coarse classes; stable `GROOT_E_*` ids carry specifics |

## Work units

| Unit | Owner | Status |
| --- | --- | --- |
| Research: runners (Claude Code, Codex, ACP) | research agent | running |
| Research: MCP SDK/protocol | research agent | running |
| Research: auth/data reference stack certification | research agent | running |
| Research: Bun 1.4, instruction discovery, generator pins | research agent | running |
| Contracts (`core/contracts/*`) | coordinator | in progress |

## Checks run since baseline

_none yet_

## Blockers

_none yet_
