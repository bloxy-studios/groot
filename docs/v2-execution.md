# Groot v2 — execution record

> Status: **living handoff record** for the v2 refactor (build brief: [GROOT_V2_BUILD_PROMPT.md](../GROOT_V2_BUILD_PROMPT.md)). Update it at every checkpoint. A fresh session resumes from **Next runnable task**.

## Current state — ⏸ PAUSED (2026-10-07, by request)

| Item | Value |
| --- | --- |
| Branch | `refactor/groot-v2-core` (from `main` @ `cfd2eb0`), local only — not pushed |
| Last checkpoint commit | see `git log -1` (context-module checkpoint `0efe58d` + this record) |
| Current gate | **B (operation core)** in progress — foundations, contracts, schemas, solver, verify engine, context module landed; executor, discovery/adoption, runners not started in-tree |
| Background work | **none running** — all subagents stopped cleanly before writing files; their (empty) worktrees and branches were removed |
| Working tree | clean |

### Next runnable task (resume here)

1. Re-dispatch the three implementation units (briefs reproducible from this record and docs/v2-architecture.md), ideally ≤ 2 in parallel on this machine:
   - **Executor** — implement `core/executor/*` behind the stub interface (`apply/resume/rollback/status`, journal, crash hook, policy, stale-plan checks) + `apply/resume/rollback/status` commands. Note: citty keeps only the last value of a repeated flag — collect `--allow` from raw args.
   - **Discovery + blueprint** — `core/discovery`, `core/blueprint` (read/serialize/migrate v1→v2), `core/registry` (exact generator resolution), `planAdopt`/`planMigrate`, `inspect/adopt/migrate` commands. Discovery must skip `node_modules`, `.git`, `.groot`, `.claude/worktrees`.
   - **Runners + tasks** — Claude Code adapter (real-run validation ≤ 2 runs, ≤ $0.75 each), Codex adapter (report blocked locally), tasks/worktrees/review/integration, `task`/`review` commands.
2. Coordinator, in parallel: tests for `core/context` (sync preserves human text, conflicts, nested shims, budgets, skills ownership) and the `context` / `context sync` / `verify` / `evidence` commands once discovery lands.
3. Then Gate C: auth/data recipes from the certified prototype (preserved locally, see Research artifacts), product-flow checker, fresh (single + monorepo) and adopted flows, interrupted-operation recovery demo; Gate D: MCP (`@modelcontextprotocol/server` ~2.3.1, lazy-loaded), task flows; Gate E: docs, changesets (prerelease `next`), compiled-binary demos, draft PR.

## Baseline (2026-10-07, before any v2 change)

Environment: macOS (darwin 25.5.0, Intel x86_64, 4 cores), Bun **1.4.0** locally (repo `packageManager` and CI pin **1.3.14**), git 2.55.0, gh 2.102.0, Claude Code 2.1.292→2.1.293, codex-cli 0.116.0.

| Check | Command | Result |
| --- | --- | --- |
| Install | `bun install --frozen-lockfile` | ✅ exit 0 |
| Lint | `bun run lint` (biome ci) | ✅ exit 0 (74 files) |
| Typecheck | `bun run typecheck` | ✅ exit 0 |
| Unit/contract tests | `bun run test` | ✅ 203 pass · 4 skip (E2E gated) · 0 fail |
| Docs/scripts tests | `bun test apps/docs scripts` | ✅ 23 pass · 0 fail |
| Build | `bun run build` | ✅ `packages/cli/dist/groot` (71.0 MB) |
| Binary smoke | `groot --version`; `groot init /tmp/groot-smoke --dry-run --yes [--json]` | ✅ `1.10.0`, v1 manifest JSON |
| Real-generator E2E | `GROOT_E2E=1 bun test generate.e2e` | ⚠️ **3 pass · 1 fail** — *pre-existing*: flagship + electron scenario timed out (420 s) inside root `bun install` under local Bun 1.4.0 on a heavily loaded machine; the other three scenarios pass. CI uses Bun 1.3.14. Re-check on an idle machine / Bun ≥ 1.4.2. |

Open upstream drift (issue #81 + new): `@tanstack/cli` 0.69→0.71.1, `create-expo-app` 4→5 (shim), `sv` 0.16→1.1.1, `create-nuxt` 3→4.0.0 — recorded, out of v2 core scope.

## Checks run since baseline

| When | Check | Result |
| --- | --- | --- |
| checkpoint 1 | `bun install --frozen-lockfile` with **Bun 1.3.14** (CI parity) on the zod-added lockfile | ✅ (lockfile stays v1) |
| checkpoint 1 | full CLI suite under **Bun 1.3.14** | ✅ 230 pass · 4 skip · 0 fail |
| checkpoint 5 | `bun test src/core` + `src/contract.test.ts` (Bun 1.4.0) | ✅ 48 pass (core 40 + contract 8) |
| every commit | `biome ci .`, `tsc --noEmit`, `bun scripts/generate-schemas.ts --check` | ✅ |

## Commits on the branch

| Commit | Content |
| --- | --- |
| `dfed540` | v2 contracts (zod), foundations (errors/exit codes, paths+symlink containment, atomic writes, writer lock, state layout, git state, redaction, process groups), structured transforms, PlanBuilder |
| `2e89845` | docs/v2-architecture.md; shared v2 command runner (`src/cli/run.ts`); executor interface stub |
| `ede18ad` | schemas/v2/* generated from contracts (+ drift test); groot.schema.json accepts v1 and v2; frozen groot.v1.schema.json; stability contract test updated |
| `daf0077` | recipe contract, capability registry, compatibility solver (+ tests), ports, env contracts; plan-id provenance |
| `58c8c49` | verification engine, evidence store (redacted artifacts), built-in structural/build checkers, server harness (+ tests) |
| `0efe58d` | context module checkpoint (managed AGENTS.md/CLAUDE.md, skills, task context) — **untested** |

## Decisions log

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | zod 4.6 is the single source for contracts: runtime validation, TS types, generated JSON Schemas | One definition; validates untrusted input at boundaries; zero deps; +0.5 MB binary |
| D2 | `groot.json` v2 is a strict superset of v1 | stability.md: init writes newest; add/doctor read both |
| D3 | Migration v1→v2 is explicit (`groot migrate`); `add` on a v1 workspace keeps writing v1 | No silent schema changes |
| D4 | `groot.lock.json` committed; `.groot/` local and self-ignoring | Portable intent + reproducibility; private recovery state stays local |
| D5 | Local state as files (JSONL journal + atomic JSON), not SQLite | Small volumes; append + replay recovery; inspectable; no platform SQLite variance |
| D6 | v2-only exit codes 6 conflict, 7 blocked, 8 locked | Coarse classes for agents; `GROOT_E_*` ids carry specifics |
| D7 | Lock/blueprint provenance references the plan id (plans ↔ operations 1:1) | Lock content is computed at plan time |
| D8 | MCP on `@modelcontextprotocol/server` 2.x (both protocol versions), lazy-loaded | Stable, Bun-supported; clients disagree on protocol version |
| D9 | Runners drive `claude -p … stream-json` and `codex exec --json` directly; ACP and Codex app-server deferred | Documented, stable interfaces; app-server experimental; ACP not native |
| D10 | Reference stack candidate: Hono + Drizzle (bun:sqlite) + Better Auth | Zero-infra, fully HTTP-verifiable; prototype passed a 24-step live flow |

## Blockers and risks

| Item | Effect | Status |
| --- | --- | --- |
| Local Codex install cannot run (installed CLI version rejects the local Codex config; account quota exhausted at research time) | Real Codex runner validation | **blocked (external)** — adapter + simulated protocol tests still planned |
| Bun 1.4.0 regressions (fixed in 1.4.1/1.4.2) | Possible signal/EINTR flakiness locally | risk — prefer Bun ≥ 1.4.2 locally |
| Heavily loaded local machine | Slow/timeout-prone E2E | risk |

## Research artifacts

Synthesis: [v2-research.md](./v2-research.md). Raw notes (machine-specific, not committed): copied to the Claude Code project data directory under `research/2026-10-07/` (runners.md, mcp.md, platform.md, platform-work/*.md, stack-work/{hono-auth,recipe,mono,scripts,flow-final.*}, baseline logs).

## Incidents

- 2026-10-07: during runner research, a mis-quoted shell argument caused three unintended real headless Claude Code runs (~$0.70 estimated) plus four small cancellation probes (~$0.04). No repository changes; disclosed to the user. Mitigation adopted: runners spawn argv arrays only, always with `-p` and explicit containment flags.
