# Groot v2 architecture

> Status: **normative design for the v2 refactor** (branch `refactor/groot-v2-core`). The v1 engine design in [architecture.md](./architecture.md) remains authoritative for the scaffold pipeline that v2 wraps. Research behind these decisions: [v2-research.md](./v2-research.md). Progress: [v2-execution.md](./v2-execution.md).

Product line: **Build it. Grow it. Prove it works.** Groot v2 is a Bun-first lifecycle CLI for developers and their coding agents: create or adopt a project, apply coherent changes through previewable plans, keep agent context current, delegate bounded work to installed agents, and attach executable evidence to every claim.

## Concepts

| Concept | Contract | Meaning |
| --- | --- | --- |
| Project | `schemas/v2/project.schema.json` | **Observed** state from read-only discovery: units (apps/packages/services), topology, toolchains, agent files, git state. Every inferred value is a fact with source, method, confidence, observation time, and the source fingerprint. |
| Blueprint | `groot.json` v2 (`schemas/v2/blueprint.schema.json`) | **Desired** state: apps, capabilities, decisions (with authority), environment contracts, verification obligations, context settings, action policy. A strict superset of the v1 manifest. |
| Capability | `capability`, `recipe` | A product or operational result (auth, data) and the certified recipes that supply it. Frameworks are surfaces; provider services are external effects; developer agents are never product capabilities. |
| Operation | `plan`, `journal-record`, `operation` | A concrete plan (actions, preconditions, ownership, env, verification, recovery) executed with an append-only journal. |
| Evidence | `evidence`, `verification` | One check outcome — pass/fail/skipped/blocked — tied to revision, environment, timing, artifacts, and limitations. |

Observed facts never silently overwrite desired state. Where they disagree, discovery reports a contradiction; reconciliation is an explicit plan.

## Module boundaries (`packages/cli/src`)

```
index.ts            thin citty entry (command registry)
commands/           presentation: flags, prompts, human rendering — v1 init/add/doctor + v2 surfaces
cli/                shared v2 runner: envelope on stdout, events on stderr, signals, exit codes
engine/, adapters/  the v1 scaffold engine — unchanged; wrapped by v2 operations
core/contracts/     zod contracts (single source: validation, TS types, schemas/v2/*.json)
core/fs/            project-boundary paths, hashing, atomic writes, writer lock
core/transforms/    structured edits: JSON pointer ops, managed regions, source anchors, lines, env
core/discovery/     static inspection → ProjectObservation (never runs project scripts or code; see the git caveat below)
core/blueprint/     groot.json read/validate/write, v1→v2 migration
core/capabilities/  recipe registry + compatibility solver
core/recipes/       certified recipes (data, auth) and v1 scaffold wrappers
core/planner/       PlanBuilder + planners (init, adopt, migrate, add-capability, context-sync)
core/executor/      apply/resume/rollback with journal checkpoints, idempotency, cancellation
core/verify/        checkers + evidence store (structural/build/runtime/product-flow)
core/context/       task context, managed AGENTS.md/CLAUDE.md regions, skills
core/runners/       installed-agent adapters (Claude Code, Codex) + capability discovery
core/tasks/         task store, dependency DAG, worktrees, review, integration
core/mcp/           MCP stdio server: typed tools over the same core functions
```

Every surface (CLI, MCP, task runners) calls the same core functions with a `CoreContext` (cwd, AbortSignal, event sink). Core code never prints or prompts; it returns typed results or throws `GrootV2Error` with a stable `GROOT_E_*` id. Policy is enforced in the executor, so no surface can bypass it.

## State

| File | Committed | Purpose |
| --- | --- | --- |
| `groot.json` | yes | Blueprint (v2) — or v1 manifest in un-migrated workspaces |
| `groot.lock.json` | yes | Exact generator versions + integrity, recipe versions + exact dependencies, Groot-owned artifacts with content hashes |
| `.groot/` | no (self-ignoring `.gitignore` inside) | `plans/`, `operations/<id>/{plan.json, journal.jsonl, state.json, backups/, logs/}`, `evidence/<id>/`, `tasks/<id>/`, `reviews/`, `lock.json` — must be a real directory inside the project: a symlinked `.groot`, `.groot/.gitignore`, or state subdirectory is refused with `GROOT_E_PATH_OUTSIDE_PROJECT`, and ids are validated before they become paths |

**Why files, not SQLite:** per-project volumes are small; recovery is append + replay; humans and agents can inspect everything; no platform SQLite variance (macOS uses Apple's system SQLite). Revisit if task queries outgrow directory scans.

## Execution

1. **Plan** — planners compute exact previews: every file write/edit carries the expected current hash and, when the content it applies to is known at planning time (on disk, or the exact result of an earlier write or previewed edit), the resulting content. An edit after a step that changes the file without a preview (`deps.add`, a deferred or secret-bearing edit, a move, a generator) is deferred (`after: null`) and computed by the executor at apply time. Env edits and edits of non-example dotenv files never carry content — `expect` pins the file hash and the edit's variable names are the preview; the plan contract rejects a `file.edit` that violates this. Generator output is marked unpredictable and runs staged. Plans list dependencies, commands, environment contracts, external effects, required action classes, verification, recovery limits, and assumptions. `fingerprint` = sha256 over intent + actions + preconditions.
2. **Apply** — validate the plan document; refuse a different root; enforce policy (`requiredClasses` ⊆ allowed); if a completed operation has the same fingerprint, return `alreadyApplied` with no effects; re-check preconditions (any affected path whose hash changed → `GROOT_E_STALE_PLAN` naming exactly those paths); take the writer lock; journal `operation.started`.
3. **Each step** — journal `step.intent` (before-hashes + backups of files about to change) → effect → journal `step.done` (after-hashes, created paths) → atomic `state.json`. Abort (SIGINT/SIGTERM/MCP cancel) stops at the next checkpoint; running children are terminated by process group; the operation becomes `interrupted` and resumable (exit 130).
4. **Resume** — replay the journal; skip completed steps; reconcile the in-flight step against its postcondition (already applied → mark done; untouched → re-run; changed by someone else → conflict); re-check preconditions for pending steps. Non-idempotent commands are never re-run blindly.
5. **Rollback** — reverse order; a file is restored/deleted only if its current hash equals the hash Groot recorded after applying it; any later human edit is a `GROOT_E_ROLLBACK_CONFLICT` naming the files (nothing is overwritten). Commands and network effects report their real compensation (e.g. restore `package.json`/`bun.lock` and re-run `bun install`) or are listed as irreversible.

Writer coordination: `.groot/lock.json` is created together with its holder record (a fully written temp file hard-linked into place; `O_CREAT|O_EXCL` where hard links are unsupported), so a live writer's lock is never observed empty; an unreadable lock counts as held and is recovered under the takeover mutex only once it is older than 10 s; stale locks from dead local processes are taken over; live or remote holders yield `GROOT_E_LOCKED` (exit 8). Read-only commands (inspect, status, context, structural verify) take no lock.

Process supervision: every child runs detached in its own process group; timeouts, cancellation, and completion sweep the whole group (SIGTERM → grace → SIGKILL) because Bun's `kill()`/`timeout`/`AbortSignal` reach only the direct child. Captured output is size-capped (whole lines dropped from the head) and secret-redacted once over the whole capture after exit — never per pipe chunk — and live output callbacks receive redacted complete lines. Evidence records are redacted in full (summary, details, reasons, next steps), not only their artifacts. Git probes run with every `GIT_*` variable removed, `core.fsmonitor` disabled, and `--no-ext-diff --no-textconv`; clean/smudge filter drivers configured in a repository's own `.git/config` can still run during `git status`/`git diff`, so an untrusted `.git` (for example from an extracted archive) should be cloned with `git clone --no-local` before Groot inspects it.

## Compatibility path (v1 → v2)

| Surface | v2 behavior |
| --- | --- |
| `init` / `add` / `doctor` flags, exit codes, stdout/stderr routing | Unchanged (contract tests) |
| `groot.json` written by `init` | **Deliberate major change:** v2 blueprint, a superset of v1 (`createdWith`, `conventions`, `scaffolds` identical). `init --dry-run --json` emits it. |
| `add` on a v1 workspace | Reads and writes v1 (no silent migration) |
| `add` on a v2 workspace | Updates `scaffolds` and `apps` together |
| `doctor` | Reads v1 and v2; `--json` shape unchanged |
| `groot migrate` | Explicit, previewable v1 → v2 plan; unknown/newer versions are rejected |
| `schemas/groot.schema.json` | Accepts v1 and v2 (discriminated by `version`); `groot.v1.schema.json` keeps the frozen v1 schema |

v2 commands use new exit codes 6 (conflict), 7 (blocked), 8 (locked); the v1 codes keep their meanings.

## Capabilities and recipes

A recipe declares requirements, conflicts, targets (unit kinds, frameworks, runtimes, topologies), exact dependency versions, environment contracts, verification contracts, external effects, and recovery. The solver orders requirements first, refuses incompatible combinations at planning time with alternatives, and reports already-satisfied capabilities. Recipes plan only through the PlanBuilder, so every change they make is previewable, owned, journaled, and reversible within stated limits.

Environment contracts name each variable's consumer, scope (server/public/build), sensitivity, requirement, and the file the consuming framework actually loads. Secrets are generated locally into gitignored files by a dedicated step; values never enter plans (enforced by the plan contract: an env or non-example dotenv edit with content is invalid), journals, logs, context, or evidence. Variables with client-exposure prefixes (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `EXPO_PUBLIC_`, …) can never be secrets.

Ports: the blueprint records each app's dev port. `groot add` in a v2 workspace allocates the next free port for a new scaffold and applies it through the adapter (dev-script `--port` or source; [architecture.md#port-allocation](./architecture.md#port-allocation)); adopted ports are recorded as observed and collisions among them are reported, never silently changed. Recipes derive coupled URLs from the target app's recorded port (e.g. `BETTER_AUTH_URL`). Verification starts apps on OS-assigned ephemeral ports, so runtime occupancy is checked separately from blueprint collisions. Re-allocating an existing app's port (and rewriting the URLs coupled to it) is not implemented yet.

Generator locks: series pins (`create-next-app@16`) resolve to exact versions with Bun's own rule (latest if it satisfies, else the highest stable match) and their registry integrity; generators run as `bunx <pkg>@<exact>`. Inputs fetched at run time (GitHub templates, dist-tags) are recorded as non-hermetic rather than claimed deterministic.

## Verification

Profiles: **structural** (fast, offline, no processes), **build** (install/typecheck/build commands), **runtime** (start the app on an ephemeral port, health probe), **product-flow** (drive the declared user flow against real wiring, e.g. sign-up → protected write → unauthorized rejection). Each check yields evidence with `pass`/`fail`/`skipped`/`blocked` and a reason; missing credentials or toolchains are `blocked` with the exact prerequisite. Reports summarize each profile separately. Evidence produced by mocks or simulated runners is flagged `simulated`.

## Context and instructions

- Root `AGENTS.md` is canonical (read natively by Codex, Cursor, Copilot, and Claude Code ≥ 2.1.277 when no CLAUDE.md exists). Groot owns one managed region (`<!-- groot:begin … sha256:… -->`) only while the well-formed hash in its begin marker matches its body — a missing or malformed hash is a conflict, never an overwrite; everything outside is human-owned. Text transforms keep the file's line endings (CRLF stays CRLF) and final newline and return the file unchanged when nothing changes; source-anchor insertion refuses a statement that continues on the next line (chains, trailing or leading operators) or whose end cannot be found; JSON pointers refuse `__proto__`/`constructor`/`prototype` tokens.
- `CLAUDE.md`: a managed region whose first content is `@AGENTS.md`. Because a root CLAUDE.md disables Claude Code's native AGENTS.md reading, every nested `AGENTS.md` gets a sibling CLAUDE.md shim.
- Skill: canonical `.agents/skills/groot/SKILL.md` (Codex and agentskills hosts) plus a byte-identical `.claude/skills/groot/SKILL.md` (Claude Code), spec-only frontmatter.
- Caps: managed region ≤ 8 KiB; warn above 16 KiB root file; refuse a root→nested chain above 32 KiB (Codex's combined budget).
- `groot context --task "…"` returns task-scoped facts (relevant units, commands, env names, decisions, acceptance checks, known gaps) with provenance; no secret values or private session state.

## Agent runners and tasks

Runners wrap documented interfaces only (Claude Code headless `claude -p --output-format stream-json`; Codex `codex exec --json`), discover capabilities truthfully (executable, version, auth state, features), and reuse each tool's own login — Groot never reads another tool's credentials. Tasks carry objective, dependencies, ownership globs, acceptance criteria, limits (wall time, turns, budget where enforceable, bounded attempts), status, attempts with observed usage, evidence, review, and integration. Each task runs in its own git worktree; overlapping ownership is serialized; integration merges into a fresh integration worktree and re-runs verification before anything reaches the user's branch.

## MCP

`groot mcp` serves typed tools over stdio that call the same core functions and policy as the CLI (inspect, plan, apply/operation status, verify, evidence, context, tasks, review, schema discovery). stdout carries only JSON-RPC; logs go to stderr. Long operations return operation ids so clients can poll after timeouts; cancellation aborts through the same AbortSignal path.
