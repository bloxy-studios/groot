# Groot v2 — expansion ledger

> Status: **living prioritized catalogue** (source: [GROOT_V2_PRODUCT_PLAN.md](../GROOT_V2_PRODUCT_PLAN.md) §7 and the build brief §12). Every item keeps a dependency and an acceptance plan; nothing ships as "supported" without the evidence in the last column. Status reflects the `refactor/groot-v2-core` branch and is updated at each checkpoint ([v2-execution.md](./v2-execution.md)).

**Priority:** P0 local v2 release gate · P1 next after v2 · P2 later capability release · P3 exploratory.
**Support:** certified (E2E evidence in CI) · experimental (implemented, evidence incomplete) · planned.

## Foundation (P0 — local v2)

| Item | Status | Depends on | Support | Evidence required |
| --- | --- | --- | --- | --- |
| Versioned contracts + published schemas (project, blueprint, lock, capability, plan, operation, evidence, task, envelope) | done | — | certified | schema drift test; contract tests |
| v1 compatibility path (init/add/doctor flags, exit codes, JSON; v1+v2 reading; explicit migration) | done (migrate: in progress) | contracts | certified | contract + process tests; v1 fixtures |
| Single-app and monorepo creation | done (single: hono certified) | v1 adapters | certified for hono single + v1 monorepo set | real-generator E2E per topology |
| Read-only discovery (`inspect`) | in progress | contracts | — | fixtures incl. custom layouts, dirty trees, symlinks, non-Bun repos |
| Adoption preserving layout + dirty/staged state | in progress | discovery, executor | — | adopt a customized project; files outside groot.json/lock untouched |
| Compatibility solver | done | capability registry | certified | refusal/ordering/ambiguity tests |
| Exact generator + recipe locks | partial (recipe locks via planner; generator resolution in progress) | registry resolver | — | lock records exact version + integrity; replay uses exact versions |
| Plans with exact previews, preconditions, ownership, recovery limits | done | PlanBuilder, transforms | certified | planner tests |
| Journaled apply/resume/rollback, writer lock, cancellation, idempotency | in progress | executor | — | crash-at-boundary, concurrent writer, SIGINT, stale-plan, rollback-conflict tests |
| Dynamic ports + runtime occupancy | done for `groot add` in v2 workspaces (allocation applied via dev-script `--port` / source); verification on ephemeral ports; re-allocating existing apps not implemented | — | experimental | unit tests (allocation matrix, `stitchDevPorts`); real E2E: `add next --path` next to a Next app serves on the allocated port |
| Environment contracts (scope, sensitivity, storage; no public secrets) | done | — | certified | contract validation + structural.env tests |
| Verification profiles + evidence (structural/build/runtime/product-flow) | done (engine); recipe checkers in progress | verify engine | — | evidence tied to revision; blocked/skipped truthful |
| Managed instructions (AGENTS.md, CLAUDE.md shims, skills) + task context | done (core); command wiring pending | discovery | — | human text preserved; conflicts; budgets |
| `groot schema` discovery | done | contracts | certified | process tests |
| MCP facade (typed tools, both protocol eras, bounded waits) | done (facade); real-API wiring pending | core API | — | client tests both eras; stdout purity |

## First capability release (P0 — reference flow)

| Item | Status | Depends on | Support | Evidence required |
| --- | --- | --- | --- | --- |
| Typed persistence: Drizzle + bun:sqlite on Hono/Bun | in progress | recipe contract, executor | prototype passed live flow | fresh single + monorepo + adopted: install, build (`data.build` bundles the entry with `db/client.ts` and `db/migrate.ts`, so a data-only app's modules are checked), migrate, runtime; the SQLite database and its `-wal`/`-shm`/`-journal` files kept out of git |
| Authentication: Better Auth (email/password) on Hono/Bun | in progress | data recipe | Groot certification flow passed (`GROOT_RECIPE_E2E`, local, not yet in CI): 26 steps — the prototype's 24, with g3 tightened to the 403 Better Auth's CSRF guard gives a cookie-bearing POST without `Origin` and g4 asserting the session survives, plus the owner's delete (j1/j2) | sign-up, session, protected write, isolation, unauthorized 401, Origin-less cookie POST 403 (CSRF), sign-out |
| Installed-agent runner: Claude Code | in progress | tasks, worktrees | — | real task: edit → acceptance → review → integration |
| Installed-agent runner: Codex | in progress (adapter) | runner contract | blocked locally (CLI/config mismatch, quota) | real task on a working Codex install |
| Task dependencies, worktrees, review, fresh integration checks | in progress | runners | — | DAG blocking, ownership overlap, integration re-verify |

## Next (P1)

| Item | Depends on | Acceptance plan |
| --- | --- | --- |
| Next.js recipe variant for auth + data (Node runtime → libsql or PGlite instead of bun:sqlite) | certified Hono path; Next adapter | `next build`/`next start` under the workspace + the same product flow over HTTP |
| Outcome-based project interview (`groot init` asks about the product, recommends a blueprint) | blueprint, solver | interview transcript → blueprint → plan identical to flag-driven plan |
| Structured blueprint input (`groot plan init --blueprint product.json`) | blueprint v2, planInit | JSON input validated; plan equals interactive result |
| Journaled `init` (init as plan + apply with internal steps) | executor internal handlers | interrupted init resumes; v1 init tests + E2E stay green |
| Drift detection + targeted repair ("observed vs desired") | discovery, blueprint, recipes | injected drift produces a narrow repair plan |
| "Explain this change" (why a file/dependency/permission changes, with provenance) | plans, ownership, decisions | every action explains recipe + decision provenance |
| Terminal dashboard over plans/tasks/evidence | stable contracts | same data as `--json`, no new state |
| `--ci` workflow + `--hooks` (v1.2 roadmap) | — | generated CI passes on a fresh workspace |
| Upstream drift pins (issue #81 + create-nuxt 4) | scaffold-flows re-verification | E2E per bumped generator |
| CI on Bun ≥ 1.4.2 (or freeze 1.3.14 everywhere) | — | full suite + E2E green on the chosen version |

## Later capability releases (P2)

| Item | Depends on | Acceptance plan |
| --- | --- | --- |
| Roles and organization tenancy | auth recipe | role-gated route: allowed vs forbidden users |
| Billing and entitlements (sandbox only) | auth, external-effect adapters + policy | sandbox checkout → entitlement → gated feature; no paid provisioning without explicit authorization |
| Email (transactional) | env contracts, external adapters | local mail catcher receives the verification mail |
| File uploads / object storage | data, env contracts | upload → authorized download → unauthorized 403 |
| Search | data | indexed query returns only the caller's rows |
| Observability (logs/traces) | runtime profile | trace emitted for a protected request |
| Background jobs + durable workflows | data, runtime | job survives restart; retries bounded |
| AI application recipes + evaluation harnesses | env contracts (provider keys as secrets) | eval suite runs with a recorded threshold; keys never in context |
| Framework upgrades + codemods | ownership, drift, recipes | upgrade plan preserves human edits; rollback conflict-safe |
| CI diagnosis/repair as tasks | tasks, evidence | failing CI log → task → passing run |
| Deployment adapters + previews + isolated preview data | external-effect policy | preview deploy behind explicit authorization; teardown compensates |

## Team, ecosystem, and surfaces (P3)

| Item | Depends on | Acceptance plan |
| --- | --- | --- |
| Shared team blueprints and policies | blueprint versioning, policy | policy enforced identically for CLI, MCP, tasks |
| Signed/community recipe registry with provenance | recipe contract, lock integrity | signature verified before planning; unsigned refused by policy |
| Hosted workers / sandboxes, remote execution | runner contract, sandbox capability matrix | same task contract, remote evidence identical in shape |
| Native API execution, provider/model routing, credential brokerage | runner contract | budget/token limits enforced by the provider; credentials via supported OAuth only |
| ACP runner kind (agents that implement ACP natively) | runner contract | session start → prompt → cancel → result on a native ACP agent |
| Native Swift, Flutter, Rust, Python, CLI targets | discovery (inspect-only today) | certified adapter per target with platform CI |
| Editor/desktop clients, voice initiation (e.g. Veyra) | MCP facade | same tools; no surface-specific policy |
| Codex app-server integration (interrupts, approvals) | Codex adapter; app-server leaving experimental | steering + interrupt round-trip |
