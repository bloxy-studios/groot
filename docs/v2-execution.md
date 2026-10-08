# Groot v2 — execution record

> Status: **living handoff record** for the v2 refactor (build brief: [GROOT_V2_BUILD_PROMPT.md](../GROOT_V2_BUILD_PROMPT.md)). Update it at every checkpoint. A fresh session resumes from **Next runnable task**.

## Current state — ▶ INTEGRATING (2026-10-08)

| Item | Value |
| --- | --- |
| Branches | `refactor/groot-v2-core` (reviewed coordinator work, HEAD `232a30c`) and **`wip/v2-integration`** (worktree `.claude/worktrees/integration`: main + executor + discovery units + integration glue). Local only — not pushed. `refactor/groot-v2-core` fast-forwards to the integration branch once every unit is merged and reviewed. |
| Current gate | **C** — operation core merged (executor, discovery, adopt/migrate, lock with exact generator versions); auth/data recipes and runners still in flight |
| Background work | (1) workflow `groot-v2-core-units` (run `wf_51587296-f9b`): runners+tasks (`worktree-wf_51587296-f9b-3`) and recipes (`-4`) implementers, then the executor and discovery adversarial reviews. (2) workflow `v2-review-fixes` (run `wf_5c648abe-1df`): fixes for the coordinator review in three file-disjoint groups (A safety primitives · B planning/transforms/policy · C solver/verification/CLI-MCP contract), each adversarially re-verified with the review's original probes |
| Placeholders | `core/recipes/index.ts` and `core/tasks/index.ts` on the integration branch are **temporary** (commit `e030a96`) and are replaced by the recipes and runners unit merges |

### Next runnable task (resume here)

1. When `v2-review-fixes` finishes: merge its three branches into `wip/v2-integration`, regenerate `schemas/v2`, pin `policy.allow` in `contract.test.ts`, apply the cross-group needs the agents reported (e.g. `0o600` for generated secret files), run lint/typecheck/test.
2. Wire dynamic port allocation (`core/ports.ts` `allocatePort`) into create (declared ports kept, collisions re-allocated, coupled URLs updated) and record adopted ports as observed — then correct the ledger row (review finding: allocation was never called).
3. When `groot-v2-core-units` finishes: merge runners (`-3`) and recipes (`-4`) replacing the placeholders (recipes carry a copy of the anchor scanner — switch it to the fixed `insertAtAnchor` conflict), address the executor/discovery review findings, run checks on Bun 1.4 + 1.3.14.
4. Gate C proof: `GROOT_E2E=1 bun test v2-flow.e2e` (fresh single-app + monorepo + adopted custom project → plan add auth → apply → verify all four profiles → context sync → crash/resume, stale plan, re-apply no-op, rollback conflict) + recipe certification; record evidence here.
5. Gate D/E: real Claude Code task-run evidence, MCP end-to-end with the real API, docs (README, architecture, stability, roadmap ledger), changesets (prerelease `next`), compiled-binary demos, push + draft PR.

### Integration branch commits (`232a30c..wip/v2-integration`, first parent)

| Commit | Content |
| --- | --- |
| `a13e205` | core API (`createApi`) + `plan` / `verify` / `evidence` / `context` / `mcp` commands |
| `174e707` | `v2-flow.e2e.test.ts` — the Gate C black-box acceptance flow (gated `GROOT_E2E=1`) |
| `054375b` · `0b06a87` · `a4fdd14` | merge main, the executor unit (journaled apply/resume/rollback, crash hook, operation commands), the discovery unit (static discovery, blueprint I/O, v1→v2 migration, registry resolution, adopt/migrate) |
| `e030a96` | temporary placeholders for the recipes and tasks units |
| `8ba24da` | init/add resolve generators to exact versions + integrity before running and write `groot.lock.json`; lock edits via `planLockUpdate` |
| `24d4201` | acceptance flow reads operation ids from `status` |

### Coordinator review (run `wf_70549802-c31`, 10 agents) — outcome

7 findings confirmed by skeptic verifiers (writer-lock double hold; git probes honouring repo/env-configured commands; dotenv contents embedded in plans; solver accepting same-solve incompatible combinations; stale exact previews after `deps.add`/deferred edits; anchor insertion mid-expression), 29 reported but not independently verified (process supervision with leftover pipe holders, chunked redaction, `.groot` symlink containment, dangling-symlink containment, `__proto__` pointers, policy classes, 64 KiB pipe truncation of human output, blocked-decision contract, context chain budget, cancelled verification, credential needs, CRLF, region hashes, mode preservation, console guard coverage, job lookup, RelPath newlines, v2 stability tripwire, `init --name ""`, `--keep-failed` in single topology, unwired port allocation). All are being fixed or rebutted with evidence by `v2-review-fixes`; the routing findings (#12/#20) were already addressed on the integration branch except `task`/`review` reservation.

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
| `efd8569` | full CLI suite (Bun 1.4.0) | ✅ 269 pass · 5 skip · 0 fail |
| `efd8569` | real single-app E2E: `GROOT_E2E=1 bun test single.e2e` (create-hono 0.19.5) | ✅ planted, stitched, installed, committed, doctor healthy, serves 200 |
| `f16b6c9` | MCP contract tests (official client, both eras + raw harness) | ✅ 6 pass |
| `f16b6c9` | Bun 1.3.14 frozen install with MCP deps | ✅ lockfile stays v1 |

## Commits on the branch

| Commit | Content |
| --- | --- |
| `dfed540` | v2 contracts (zod), foundations (errors/exit codes, paths+symlink containment, atomic writes, writer lock, state layout, git state, redaction, process groups), structured transforms, PlanBuilder |
| `2e89845` | docs/v2-architecture.md; shared v2 command runner (`src/cli/run.ts`); executor interface stub |
| `ede18ad` | schemas/v2/* generated from contracts (+ drift test); groot.schema.json accepts v1 and v2; frozen groot.v1.schema.json; stability contract test updated |
| `daf0077` | recipe contract, capability registry, compatibility solver (+ tests), ports, env contracts; plan-id provenance |
| `58c8c49` | verification engine, evidence store (redacted artifacts), built-in structural/build checkers, server harness (+ tests) |
| `0efe58d` | context module checkpoint (managed AGENTS.md/CLAUDE.md, skills, task context) — **untested** |
| `03263c2` | research synthesis + paused execution record |
| `f93b301` | context module tests (9) — sync preserves human text, conflicts, shims, budgets, skills, task context |
| `8e91361` | release hardening: compiled binaries no longer autoload .env/bunfig (probe-proven leak), `--no-orphans` |
| `e4f4caa` | `groot schema` discovery command |
| `9c45d0b` | add-capability planner; solver refuses ambiguous recipe/app choices; injectable recipe catalog |
| `4786e93` | docs/v2-cli-spec.md (normative v2 contract, draft) |
| `efd8569` | **BREAKING** init writes v2 blueprint; `--topology single`; v1 compat path (add keeps version, doctor/preset read v2, env contracts) |
| `f16b6c9` | MCP facade (18 tools, both protocol eras, bounded waits, stdout purity tests) |

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
