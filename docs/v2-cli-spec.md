# groot v2 CLI specification

> Status: **normative contract for the v2 surfaces** (prerelease on branch `refactor/groot-v2-core`). The v1 commands `init`, `add`, and `doctor` remain specified by [cli-spec.md](./cli-spec.md); deliberate v2 changes to them are listed under [Compatibility](#compatibility-with-v1). Architecture: [v2-architecture.md](./v2-architecture.md). Machine contracts: [`schemas/v2/`](../schemas/v2/index.json) (`groot schema` lists them).

## Machine contract

Every v2 command shares one contract, implemented once in `src/cli/run.ts`:

| Rule | Behavior |
| --- | --- |
| `--json` | stdout carries exactly **one** result envelope ([`result.schema.json`](../schemas/v2/result.schema.json)): `{ kind: "groot.result", command, ok, data, error, blocked[], warnings[], refs, grootVersion }`. Nothing else is written to stdout. |
| Progress | Always on stderr: human lines by default, JSONL events ([`event.schema.json`](../schemas/v2/event.schema.json)) with `--events`. |
| Errors | `error = { id, message, hint, exitCode, details }` with a stable `GROOT_E_*` id. Branch on `id`, never on message text. |
| Blocked decisions | When a choice, prerequisite, credential, or policy approval is missing, commands return `ok: false` with `blocked[]` entries (question, options with effects and a recommendation, `resolveWith`) and exit 7 — they never wait for input. |
| No hidden prompts | Without a TTY a v2 command never prompts. Interactive choices are offered only to humans on a TTY and always have a flag equivalent. |
| Interruption | SIGINT/SIGTERM abort through the operation's AbortSignal: the executor stops at the next checkpoint, terminates child process groups, records `interrupted`, and exits 130. A second SIGINT forces exit 130 immediately. |
| References | `refs` carries `planId`, `operationId`, `taskId`, and evidence ids so follow-up commands and agents can address results. |
| Secrets | Values are never printed, logged, or stored in plans, journals, evidence, or context; artifacts are redacted. |

### Exit codes

| Code | Meaning (v2 surfaces) |
| --- | --- |
| 0 | Success |
| 1 | Internal error (a bug) |
| 2 | Usage error, invalid document, or request refused at planning time (unknown/incompatible capability, unsupported project) |
| 3 | Preflight failure (missing toolchain) |
| 4 | A command or generator failed |
| 5 | Verification failed |
| 6 | Conflict: stale plan, changed precondition, ownership or rollback conflict |
| 7 | Blocked: decision, prerequisite, credential, or policy approval required (`blocked[]`) |
| 8 | Locked: another groot process is changing the project |
| 130 | Interrupted or cancelled (operations stay resumable) |

v1 codes 0/1/2/3/4/5/130 keep their meanings; 6/7/8 are new and only v2 surfaces return them.

### Error ids

`GROOT_E_INTERNAL`, `GROOT_E_USAGE`, `GROOT_E_PREFLIGHT`, `GROOT_E_GENERATOR`, `GROOT_E_COMMAND_FAILED`, `GROOT_E_VERIFY_FAILED`, `GROOT_E_NOT_A_PROJECT`, `GROOT_E_NOT_REGISTERED`, `GROOT_E_MIGRATION_REQUIRED`, `GROOT_E_UNSUPPORTED_SCHEMA`, `GROOT_E_INVALID_DOCUMENT`, `GROOT_E_UNSUPPORTED_PROJECT`, `GROOT_E_INCOMPATIBLE`, `GROOT_E_UNKNOWN_CAPABILITY`, `GROOT_E_STALE_PLAN`, `GROOT_E_CONFLICT`, `GROOT_E_OWNERSHIP_CONFLICT`, `GROOT_E_ROLLBACK_CONFLICT`, `GROOT_E_PATH_OUTSIDE_PROJECT`, `GROOT_E_POLICY_DENIED`, `GROOT_E_BLOCKED`, `GROOT_E_LOCKED`, `GROOT_E_INTERRUPTED`, `GROOT_E_NOT_FOUND`, `GROOT_E_NOT_RESUMABLE`, `GROOT_E_RUNNER_UNAVAILABLE`, `GROOT_E_TASK_STATE`. `groot schema --json` returns each id with its exit code. Renaming or removing an id is a breaking change.

## Commands

All commands accept `--json` and `--events`. Paths in documents are project-relative POSIX paths.

### `groot inspect [dir]`

Read-only discovery. Reads manifests and configuration statically — never executes repository code; may run toolchain `--version` probes and read-only git commands. Data: [`project.schema.json`](../schemas/v2/project.schema.json) — units, topology, package manager, toolchains, agent files (with managed-region state), capability observations, git state (staged/unstaged/untracked), registration (`unregistered | v1 | v2 | invalid | unsupported-version`), writable support level (`certified | inspect-only | unsupported`) with reasons and a next step, unknowns, and contradictions. Every inferred value carries source, method, confidence, observation time, and the source fingerprint. Env variable **names** only. Exit 0 for any readable directory.

### `groot adopt [dir] [--dry-run]`

Registers an existing certified (Bun/TypeScript) project: writes `groot.json` (v2 blueprint derived from discovery) and `groot.lock.json` — nothing else. Existing layout, scripts, configuration, human instruction files, and dirty or staged changes are preserved; rearranging the repository is never part of adoption. `--dry-run` prints and saves the plan (apply it later with `groot apply <planId>`). Refusals: inspect-only/unsupported projects → `GROOT_E_UNSUPPORTED_PROJECT` (exit 2) with the actionable next step; already registered → `GROOT_E_CONFLICT`; a v1 workspace → `GROOT_E_MIGRATION_REQUIRED`.

### `groot migrate [dir] [--dry-run]`

Explicit, deterministic `groot.json` v1 → v2 migration (byte-identical output for the same input), plus `groot.lock.json`. Previewable; the plan is stale if `groot.json` changes after planning; rollback restores the v1 file. Unsupported versions are rejected with `GROOT_E_UNSUPPORTED_SCHEMA`.

### `groot plan add <capability>... [--target <app>] [--recipe <id>] [--experimental] [--out <file>]`

Resolves capabilities (e.g. `auth`, `data`) into one plan ([`plan.schema.json`](../schemas/v2/plan.schema.json)): solver selections in application order, exact recipe and dependency versions, every file write/edit with exact previews and expected hashes, dependency changes, commands, environment contracts, external effects (none for local recipes), preconditions, ownership, required action classes, verification obligations, recovery mode and limits, and assumptions. Refusals happen here — unknown capability (`GROOT_E_UNKNOWN_CAPABILITY`), incompatible target or conflicting library (`GROOT_E_INCOMPATIBLE`), several candidate apps or recipes (`ambiguous-choice`, resolve with `--target`/`--recipe`) — with alternatives. The plan is saved under `.groot/plans/`; `--out` also writes it to a file. Requires a v2-registered project.

`groot plan context-sync` produces the plan for managed instruction synchronization with the same contract. (`groot plan init` — creation as a journaled, resumable plan — is planned; see [v2-ledger.md](./v2-ledger.md). `groot init` remains the one-step creation command.)

### `groot apply <plan-file | planId> [--allow <class>...]`

Executes a plan. Validates the document, requires the same project root, enforces the action policy (`groot.json` `policy`; `--allow` grants extra action classes for this run — repeatable or comma-separated), and re-checks every precondition: if any file the plan touches changed since planning, `GROOT_E_STALE_PLAN` (exit 6) names exactly those paths and nothing is written. Re-applying a completed plan is a no-op (`alreadyApplied: true`). Data: [`operation-result.schema.json`](../schemas/v2/operation-result.schema.json).

### `groot status [operationId]`

Operations (newest first) with intent, status, steps done/total, and resumability; the current lock holder if one exists. With an id: that operation's state ([`operation.schema.json`](../schemas/v2/operation.schema.json)).

### `groot resume <operationId> [--retry-step <id> | --skip-step <id>]`

Continues an interrupted or failed operation from its journal: completed steps are skipped, the in-flight step is reconciled against its recorded postcondition, and pending steps re-check their own preconditions (narrow `GROOT_E_STALE_PLAN` for anything a human changed meanwhile). A non-idempotent command interrupted mid-flight is never re-run blindly: resume returns blocked until `--retry-step` or `--skip-step` decides it.

### `groot rollback <operationId> [--dry-run]`

Previews ([`rollback.schema.json`](../schemas/v2/rollback.schema.json)) or executes recovery in reverse step order. A file is restored or deleted only if its content still equals what Groot wrote; any later human edit makes the rollback refuse with `GROOT_E_ROLLBACK_CONFLICT` (exit 6) and change nothing. Dependency changes are compensated by restoring `package.json`/`bun.lock` and re-running `bun install`. Effects without a safe inverse are listed as irreversible.

### `groot verify [--profile <p>[,<p>]] [--capability <id>] [--unit <path>]`

Runs verification contracts — the blueprint's plus defaults — for the selected profiles (default `structural,build`): **structural** (offline, no processes), **build** (the unit's own typecheck/build scripts or local compiler), **runtime** (start the app on an ephemeral loopback port and probe it), **product-flow** (drive the declared flow against real wiring, e.g. sign-up → protected write → unauthorized rejection). Each check yields evidence ([`evidence.schema.json`](../schemas/v2/evidence.schema.json)) with `pass | fail | skipped | blocked`, the revision (HEAD + worktree fingerprint) and environment it ran against, timing, redacted artifacts, limitations, and — for skipped/blocked — the reason and next step. Report: [`verification.schema.json`](../schemas/v2/verification.schema.json) with one summary per profile. Exit 5 if any check failed; otherwise exit 7 if a requested check was blocked; else 0.

### `groot evidence [id]`

Lists stored evidence (newest first) or shows one record and its artifact paths.

### `groot context [--task "<goal>"]` · `groot context sync [--dry-run] [--skip-conflicts]`

`context` returns task-scoped knowledge ([`context.schema.json`](../schemas/v2/context.schema.json)): relevant units with relevance and reasons, commands, environment variable names and storage, decisions, acceptance checks, latest evidence, known gaps, and sources. `context sync` plans and applies the managed instruction projection: a hash-guarded region in `AGENTS.md`, an `@AGENTS.md` import in `CLAUDE.md` (plus sibling shims for nested `AGENTS.md`), and the groot skill in `.agents/skills/groot/` and `.claude/skills/groot/`. Human text outside managed regions is never changed; a hand-edited region or unowned skill file is a conflict (exit 6) unless `--skip-conflicts` syncs everything else.

### `groot task create|list|show|run|resume|integrate` · `groot review <taskId>`

Bounded work for installed coding agents ([`task.schema.json`](../schemas/v2/task.schema.json)): objective, runner (`claude-code` | `codex`), dependencies, ownership globs, acceptance commands or verification profiles, limits (wall time, turns, budget where the runner enforces it, bounded attempts). `run` executes in an isolated git worktree after dependency, ownership-overlap, and runner capability/authentication checks; Groot commits the agent's changes and runs the acceptance checks (evidence). `review` summarizes the change set ([`review.schema.json`](../schemas/v2/review.schema.json)) — files, ownership violations, secret findings (locations only), acceptance results — and records `--approve` or `--request-changes`. `integrate` merges an approved task in a fresh integration worktree, re-runs acceptance and verification there, and fast-forwards the target branch only when the main worktree is clean (otherwise the integration branch is left for the user and the result is blocked). Runner states that prevent work — not installed, not authenticated, incompatible configuration, quota exhausted — are `blocked` with the exact cause.

### `groot mcp`

Serves the same core operations as typed MCP tools over stdio (protocol revisions 2026-07-28 and 2025-06-18). stdout carries only JSON-RPC; logs go to stderr. Long operations return operation ids; clients poll status and may cancel.

### `groot schema [name]`

Lists contracts (with schema URLs), commands, capabilities and recipes in this build, error ids with exit codes, and the exit-code table; with a name, prints that contract's JSON Schema.

## Action classes and policy

Plans declare the classes of effect they need: `fs.create`, `fs.edit`, `fs.delete`, `fs.move`, `deps.change`, `install`, `generator`, `command`, `network`, `git`, `process`, `external`. `groot.json` `policy.allow` lists what runs without extra approval (default: everything local); `policy.external` (`deny` | `ask`) governs effects on provider accounts, which always need an explicit `--allow external` and an adapter that supports them. The CLI, MCP tools, and task runners all go through the same executor check.

## State files

| Path | Committed | Contents |
| --- | --- | --- |
| `groot.json` | yes | Blueprint v2 (or a v1 manifest until migrated) |
| `groot.lock.json` | yes | Exact generator versions/integrity, recipe versions and dependencies, Groot-owned artifacts with content hashes |
| `.groot/` | no (self-ignoring) | plans, operation journals and backups, evidence, tasks, reviews, worktrees, the writer lock |

## Bare-word routing

`bun create groot <dir>` passes a bare destination; a leading word that is not a groot command is routed to `init`. v2 command names (`inspect`, `adopt`, `migrate`, `plan`, `apply`, `verify`, `evidence`, `status`, `resume`, `rollback`, `context`, `task`, `review`, `mcp`, `schema`) are now reserved: use `groot init <dir>` to create a project whose directory has one of these names.

## Compatibility with v1

| Surface | v2 behavior |
| --- | --- |
| `init` / `add` / `doctor` flags, exit codes, stdout/stderr routing | Unchanged |
| `groot.json` written by `init`, and `init`/`add --dry-run --json` output | **Deliberate change:** version 2 blueprint — a strict superset of v1 (`createdWith`, `conventions`, `scaffolds` keep their v1 meaning) |
| `add` on a v1 workspace | Reads and writes v1 (no silent migration) |
| `doctor` | Reads v1 and v2; `--json` shape unchanged |
| `schemas/groot.schema.json` | Same URL; validates v1 and v2 documents (discriminated by `version`); the frozen v1 schema is `schemas/groot.v1.schema.json` |
| Pinning v1 behavior | `bunx create-groot@1` keeps the v1 CLI; v1 CLIs reject version 2 files with an "unsupported manifest version" usage error |
