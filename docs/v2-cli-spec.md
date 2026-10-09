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
| Interruption | SIGINT/SIGTERM abort through the operation's AbortSignal: the executor stops at the next checkpoint, terminates child process groups, records `interrupted`, and exits 130. A second SIGINT forces exit 130 immediately — every child process group Groot still supervises is SIGKILLed on the way out. |
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

Read-only discovery. Reads manifests and configuration statically — never runs project scripts or imports project code; may run toolchain `--version` probes and read-only git commands. Git runs with every `GIT_*` environment variable removed except `GIT_CEILING_DIRECTORIES`, with `core.fsmonitor` and all hooks disabled (`core.hooksPath=/dev/null`), without writing the index (`GIT_OPTIONAL_LOCKS=0`, `diff.autoRefreshIndex=false`), and with `--no-ext-diff --no-textconv`; only clean/smudge/process filter drivers configured in the repository's own `.git/config` can still run during `git status`/`git diff` — clone an untrusted repository (for example an extracted archive containing `.git`) with `git clone --no-local` instead of inspecting it in place. Data: [`project.schema.json`](../schemas/v2/project.schema.json) — units, topology, package manager, toolchains, agent files (with managed-region state), capability observations, git state (staged/unstaged/untracked), registration (`unregistered | v1 | v2 | invalid | unsupported-version`), writable support level (`certified | inspect-only | unsupported`) with reasons and a next step, unknowns, and contradictions. Every inferred value carries source, method, confidence, observation time, and the source fingerprint. Env variable **names** only. Exit 0 for any readable directory.

### `groot adopt [dir] [--dry-run]`

Registers an existing certified (Bun/TypeScript) project: writes `groot.json` (v2 blueprint derived from discovery) and `groot.lock.json` — nothing else. Existing layout, scripts, configuration, human instruction files, and dirty or staged changes are preserved; rearranging the repository is never part of adoption. `--dry-run` prints and saves the plan (apply it later with `groot apply <planId>`). Refusals: inspect-only/unsupported projects → `GROOT_E_UNSUPPORTED_PROJECT` (exit 2) with the actionable next step; already registered → `GROOT_E_CONFLICT`; a v1 workspace → `GROOT_E_MIGRATION_REQUIRED`.

### `groot migrate [dir] [--dry-run]`

Explicit, deterministic `groot.json` v1 → v2 migration (byte-identical output for the same input), plus `groot.lock.json`. Previewable; the plan is stale if `groot.json` changes after planning; rollback restores the v1 file. Unsupported versions are rejected with `GROOT_E_UNSUPPORTED_SCHEMA`.

### `groot plan add <capability>... [--target <app>] [--recipe <id>] [--experimental] [--out <file>]`

Resolves capabilities (e.g. `auth`, `data`) into one plan ([`plan.schema.json`](../schemas/v2/plan.schema.json)): solver selections in application order, exact recipe and dependency versions, every file write/edit with exact previews and expected hashes, dependency changes, commands, environment contracts, external effects (none for local recipes), preconditions, ownership, required action classes, verification obligations, recovery mode and limits, and assumptions. Refusals happen here, with alternatives — unknown capability (`GROOT_E_UNKNOWN_CAPABILITY`, exit 2) and incompatible target, conflicting library, or recipes that cannot be combined, including combinations requested together (`GROOT_E_INCOMPATIBLE`, exit 2). Several candidate apps or recipes is not an incompatibility but a missing decision: `GROOT_E_BLOCKED` (exit 7) with a `blocked[]` decision listing the options, resolved by appending `--target <app>` or `--recipe <id>`. `--recipe` is repeatable and attaches to the capability that recipe supplies — a dependency included (`groot plan add auth --recipe data.drizzle-sqlite`); two different recipes for one capability are a usage error. Re-requesting a capability the target already has is reported as already satisfied. The plan is saved under `.groot/plans/`; `--out` also writes it to a file. Requires a v2-registered project.

Built-in recipes — `data.drizzle-sqlite` (Drizzle on `bun:sqlite`) and `auth.better-auth` (Better Auth email + password, which requires data) — target Hono API apps on Bun, single or monorepo, through the app's TypeScript server entry:

- Auth's routes (`/api/auth`, `/api/notes`) are mounted in the managed region `auth.routes`, right after `const app = new Hono()` — ahead of middleware added later with `app.use(…)`, which therefore does not run for them (the plan's assumptions say so). To put them behind it, move the `groot:begin`/`groot:end` `auth.routes` block below that middleware; re-planning refreshes the block where it stands.
- A declaration whose statement continues past its line — `new Hono()` chained into `.use(…)`, with comments in between or not — is refused (`GROOT_E_CONFLICT`): end the declaration first (`const app = new Hono();`, then `app.use(…)`).
- A `BETTER_AUTH_SECRET` assignment in `.env.local` that Bun loads as blank (`BETTER_AUTH_SECRET=`, empty quotes, only a `# comment`) is refused (`GROOT_E_CONFLICT`): delete the line (Groot then generates a secret) or set a value. A non-blank value is kept.
- `.env.local` and the app's `data/` directory (the SQLite database and its `-wal`/`-shm`/`-journal` files) count as ignored only through the repository's own `.gitignore` files — `.git/info/exclude` and `core.excludesFile` don't travel with a clone; missing lines are added to the nearest `.gitignore`. A tracked `.env.local` is refused (`GROOT_E_CONFLICT`).
- The entry's directory may use letters, digits, spaces, and `. _ - @ +`; any other character is refused at planning (`GROOT_E_INCOMPATIBLE`).

`groot plan context-sync` produces the plan for managed instruction synchronization with the same contract. (`groot plan init` — creation as a journaled, resumable plan — is planned; see [v2-ledger.md](./v2-ledger.md). `groot init` remains the one-step creation command.)

### `groot apply <plan-file | planId> [--allow <class>...]`

Executes a plan as a journaled, resumable operation. Data: [`operation-result.schema.json`](../schemas/v2/operation-result.schema.json).

- **Document.** A plan file is untrusted. Besides the plan contract it must be internally consistent: the fingerprint and every exact preview match, step ids are unique, a `produced` expectation names an earlier step that produces exactly that path (no precondition may expect one), and no action names a path inside `.groot/` or `.git/` (in any spelling the filesystem or git would match). Anything else is `GROOT_E_INVALID_DOCUMENT`. The plan must target this project root.
- **Policy.** The action policy comes from a v2 `groot.json` (`policy`); the default policy applies only to a project without a v2 blueprint (no `groot.json`, or a v1 manifest). Loading fails closed: an invalid `groot.json` is `GROOT_E_INVALID_DOCUMENT` and an unknown version `GROOT_E_UNSUPPORTED_SCHEMA`, never a fallback to the default. `--allow` grants extra action classes for this run (repeatable or comma-separated); a denial returns blocked decisions (exit 7), one per denied class, each naming the exact re-run.
- **Preconditions.** Every precondition is re-checked — those the plan declares and those its actions imply: each action's own expectation of a path no earlier step changes, a generator's destination still fresh, a move's target still absent. If any path the plan touches changed since planning, `GROOT_E_STALE_PLAN` (exit 6) names exactly those paths and nothing is written. Toolchain preconditions probe only the toolchains discovery knows — bun is the running runtime; the others are found on `PATH`, never inside the project, and asked for their version from a neutral directory. Any other toolchain is a stale finding and is never executed.
- **Each step.** Right before a step runs, its paths are checked where they really resolve: a symlink into `.groot/` or `.git/` is `GROOT_E_PATH_OUTSIDE_PROJECT`.
- **Saved plans** (`groot apply <planId>`) conceal the secret values Groot knows, like operation plan copies. One whose quoted value changed since it was saved is `GROOT_E_STALE_PLAN` naming the env file.
- **Re-applying** a completed plan is a no-op (`alreadyApplied: true`). A plan whose operation is unfinished is `GROOT_E_CONFLICT` pointing at `groot resume` (or `groot rollback` while it is rolling back); a rolled-back plan may be applied again.

### `groot status [operationId]`

Operations (newest first) with intent, status, steps done/total, and resumability; the current lock holder if one exists. With an id: that operation's state ([`operation.schema.json`](../schemas/v2/operation.schema.json)). Takes no lock.

- An operation journaled as running whose writer is gone (no live lock holder for it) is reported `interrupted` and resumable; one whose writer is still live is `running` and not resumable.
- A *sealed* operation — its plan copy quotes a secret whose value changed since it started — is listed and readable but `resumable: false`; it can still be rolled back.
- A symlinked `.groot` (or state subdirectory) is `GROOT_E_PATH_OUTSIDE_PROJECT`, never an empty list.

### `groot resume <operationId> [--retry-step <id> | --skip-step <id>] [--allow <class>...]`

Continues an interrupted or failed operation from its journal: completed steps are skipped, the in-flight step is reconciled against its recorded postcondition, and pending steps re-check their own preconditions (narrow `GROOT_E_STALE_PLAN` for anything a human changed meanwhile). The plan the journal started, the step in flight, and the policy check are all decided from one read of the journal, taken under the writer lock.

- **Policy.** The steps still to run are held to the project policy again (loaded as for `apply`). Approvals are per run — those given to `apply` are not journaled and do not carry over — so `--allow <class>` (repeatable or comma-separated) is needed again; a denial returns blocked decisions naming `groot resume <operationId> --allow <class>`.
- **Plan copy.** It must be the plan the journal started (same plan id and fingerprint), otherwise `GROOT_E_INVALID_DOCUMENT`. A copy that quotes a secret whose value changed since the operation started cannot be revealed exactly: resuming it is `GROOT_E_CONFLICT` (exit 6) naming the variable and its env file — put the previous value back to resume, or roll the operation back.
- **Interrupted commands.** A non-idempotent command interrupted mid-flight is never re-run blindly: resume returns blocked until `--retry-step` or `--skip-step` decides it.
- **Interrupted generators** are settled by their record. A complete, unchanged result is done. A cut-off staged promotion whose present entries all still hold exactly what it moved is cleared and re-run. Anything else is the retry/skip decision, whose retry option names what it removes first. A `.git` or `.groot` is never removed: `--retry-step` while the destination holds one (nested ones included) is `GROOT_E_CONFLICT`.

### `groot rollback <operationId> [--dry-run]`

Previews ([`rollback.schema.json`](../schemas/v2/rollback.schema.json)) or executes recovery in reverse step order. A file is restored or deleted only if its content still equals what Groot wrote; any later human edit makes the rollback refuse with `GROOT_E_ROLLBACK_CONFLICT` (exit 6) and change nothing. The same conflict, naming what blocks it, covers:

- a `.git` or `.groot` that undoing a step would delete — Groot never deletes one, nested ones included (the project root keeps its own);
- a backup that quotes a secret whose value changed or is gone — it names the variable; put the value back to roll back.

Links a step created are removed, never followed. Steps with nothing else to undo still remove the empty directories they created. Dependency changes are compensated by restoring `package.json`/`bun.lock` from backup, then running `bun install --no-save` in the project root (10-minute cap). Rollback takes no `--allow`: the compensating install runs without a policy check, and when it fails the rollback still completes, with a next step to run `bun install` yourself. Effects without a safe inverse are listed as irreversible. A sealed operation (see `groot status`) can be rolled back.

### `groot verify [--profile <p>[,<p>]] [--capability <id>] [--unit <path>]`

Runs verification contracts — the blueprint's plus defaults — for the selected profiles (default `structural,build`): **structural** (offline, no processes), **build** (the unit's own typecheck/build scripts or local compiler), **runtime** (start the app on an ephemeral loopback port and probe it), **product-flow** (drive the declared flow against real wiring, e.g. sign-up → protected write → unauthorized rejection). Each check yields evidence ([`evidence.schema.json`](../schemas/v2/evidence.schema.json)) with `pass | fail | skipped | blocked`, the revision (HEAD + worktree fingerprint; before the first commit the fingerprint covers working-tree content) and environment it ran against, timing, redacted artifacts, limitations, and — for skipped/blocked — the reason and next step. Report: [`verification.schema.json`](../schemas/v2/verification.schema.json) with one summary per profile. A check that needs credentials which are not set is `blocked` with reason `credential(s) not set: NAMES` (names only) and a `credential` decision. A credential counts as set when the environment holds a non-empty value or its storage file assigns one that Bun loads as non-blank — `NAME=`, `NAME=""`, and `NAME= # note` leave a variable unset; the same rule decides `structural.env`'s required variables, which are read from their storage files. `structural.env` also fails when a secret's storage file is not ignored by the repository's own `.gitignore` files (`.git/info/exclude` and `core.excludesFile` don't travel with a clone). Exit 5 if any check failed; otherwise exit 7 if a requested check was blocked; else 0. A run cut short by Ctrl-C (or MCP cancellation) reports `interrupted: true` and `ok: false` and exits 130 (`GROOT_E_INTERRUPTED`) only when a selected check did not finish; under cancellation only a failing check is recorded as skipped/`cancelled` (a check's own pass, blocked, or skipped result stands), and cancelled placeholders never hide earlier evidence.

### `groot evidence [id]`

Lists stored evidence (newest first) or shows one record and its artifact paths.

### `groot context [--task "<goal>"]` · `groot context sync [--dry-run] [--skip-conflicts]`

`context` returns task-scoped knowledge ([`context.schema.json`](../schemas/v2/context.schema.json)): relevant units with relevance and reasons, commands, environment variable names and storage, decisions, acceptance checks, latest evidence, known gaps, and sources. `context sync` plans and applies the managed instruction projection: a hash-guarded region in `AGENTS.md`, an `@AGENTS.md` import in `CLAUDE.md` (plus sibling shims for nested `AGENTS.md`), and the groot skill in `.agents/skills/groot/` and `.claude/skills/groot/`. Human text outside managed regions is never changed; a hand-edited region or unowned skill file is a conflict (exit 6) unless `--skip-conflicts` syncs everything else.

### `groot task create|list|show|run|resume|integrate` · `groot review <taskId>`

Bounded work for installed coding agents ([`task.schema.json`](../schemas/v2/task.schema.json)). Tasks need a git repository with at least one commit (a `groot.json` is only required for `--accept-verify`).

- `task create "<objective>" [--title] [--runner claude-code|codex] [--model <id|alias>] [--depends-on <taskId>]... [--owns <glob>]... [--accept "<command>"]... [--accept-verify <profile>]... [--wall-time <s>] [--max-turns <n>] [--max-budget-usd <n>] [--max-attempts 1-5] [--accept-timeout <s>]`.
  - Acceptance commands are split into argv and run without a shell.
  - Ownership defaults to `**`.
  - Limits are per attempt and default to 900 s wall time, 25 turns, a $2 budget (Claude Code enforces it; Codex reports tokens only) and 2 attempts. Each acceptance check times out after 600 s by default. `--wall-time` and `--accept-timeout` accept at most 86400 s (24 hours); a larger value is a usage error (exit 2).
- `task list` · `task show <id>`. A run whose Groot process died is shown as it will be reconciled — `interrupted`, or still `running` with a reason while its runner is alive — without writing or signalling anything (MCP task reads behave the same).
- `task run <id>` or `task run --ready [--parallel 1-4]` (`[--effort <level>]`).
  - Before starting it checks dependencies, ownership overlap with running tasks (overlapping tasks are serialized), and runner capability and authentication; the task is re-validated when it is claimed, under the project lock.
  - The run happens in an isolated git worktree (`.groot/worktrees/<id>`, branch `groot/task/<id>`). The prompt carries the task-scoped project context (`groot context --task`: names and commands, never secret values).
  - Groot commits the agent's change (never staging new files under `node_modules`) and runs the acceptance checks, recording evidence.
  - Dependencies: before the checks, a worktree with a Bun lockfile gets `bun install --frozen-lockfile` when `node_modules` is git-ignored in any form (`node_modules`, `node_modules/`, `/node_modules/`). The install is recorded as the evidence check `task.dependencies`; if it fails, the checks are blocked. Otherwise nothing is installed, and the evidence says packages can resolve from the main checkout's `node_modules`.
  - Before review, the checks run code nobody has reviewed. The dependency install, the acceptance commands, and the build/typecheck scripts (and any app) a verify criterion runs all get an environment with credential-like variables removed — but there is no OS sandbox: that code can use the network and read and write any file the user can. Every piece of pre-review evidence says it ran without a sandbox; the install's and the acceptance commands' evidence also says credentials were removed.
  - Repository guard: while the agent runs, while its code runs in the pre-review checks (re-checked after each check), and during integration's fresh checks, Groot compares every git ref, both HEADs, and the git directory's config, hooks, and info files. Only other tasks' `groot/*` branches, remote-tracking refs, and Groot's own journaled fast-forwards may move. Any other change — a commit made meanwhile on the target branch included — blocks the task (exit 7) with the exact list and stops the remaining checks; running the task (or the integration) again continues. Groot's own git never runs repository hooks or an fsmonitor (`core.hooksPath=/dev/null`, `core.fsmonitor=false`).
  - A failed check gets a bounded retry that continues the same session with the failing output. A Claude Code session that no longer exists ("No conversation found") is replaced by a fresh one — with the task prompt, project context, and the reason — without spending an attempt.
  - Ctrl-C interrupts the whole process group, and `task resume <id>` continues the session. While a runner is live, SIGHUP (a closed terminal) kills its process group and Groot exits 129. A runner left behind by a Groot process that died is stopped by the next `task run`/`task resume` only when its process-group leader's start time proves it is that runner; otherwise it is never signalled, and the task's reason says what to check.
  - `task run --ready` exits with the most serious outcome: 130 if any task was interrupted; otherwise the exit code of a task that could not start (its error is in `warnings[]`); otherwise 5 if a task failed its checks or attempts; otherwise 7 if one is blocked; otherwise any other non-zero code; else 0.
- `review <taskId> [--approve | --request-changes "<notes>"]` summarizes the change set ([`review.schema.json`](../schemas/v2/review.schema.json)): files, ownership violations, secret findings (locations only) and acceptance results. It then records the decision; requested changes send the task back to the agent. A decision waits for the project lock and is written against a fresh read (a task that changed meanwhile is refused). Without a decision, review never waits behind another operation: when the lock is not free within 2 s, the summary is returned unrecorded with a warning (with `--json`, also in the envelope's `warnings`).
- `task integrate <id>` merges an approved task (`--no-ff`) in a fresh integration worktree (branch `groot/integrate/<id>`), installs its dependencies first (same rule as above), and re-runs acceptance plus structural/build verification there with the caller's environment. A check that could not run (`blocked`) gates like a failure; only an unregistered project's skipped structural/build verification does not (the result then says the acceptance checks passed with verification skipped, not "after fresh checks passed"). It fast-forwards the main checkout only when that checkout is clean and on the target branch, recording the move in `.groot/ref-moves.jsonl` before making it, so tasks running beside it are not blocked by Groot's own move. Merge conflicts abort the merge and drop the integration branch; failed checks or a dirty or switched checkout leave `groot/integrate/<id>` in place. In each case the target branch is unchanged and the result is blocked.

Runner states that prevent work (not installed, not authenticated, incompatible configuration, quota exhausted) are `blocked` with the exact cause and next step.

Exit codes: 0 · 2 usage · 5 a check failed · 7 blocked · 130 interrupted.

Runners drive the documented headless interfaces: `claude -p --output-format stream-json` with explicit permission and tool containment, and `codex exec --json` with the workspace-write sandbox. Every Claude run passes `--safe-mode`, `--tools Read,Edit,Write,Glob,Grep,Bash`, and a strict OS sandbox for Bash; a Claude Code whose `--help` lacks `--tools` or `--safe-mode` is blocked as `incompatible`, and a sandbox that cannot start blocks the task (`sandbox-unavailable`). Details and residual risks: [v2-architecture.md](./v2-architecture.md#agent-runners-and-tasks). Usage is reported as observed tokens plus Claude Code's own cost estimate, labeled as an estimate.

### `groot mcp`

Serves the same core operations as typed MCP tools over stdio (protocol revisions 2026-07-28 and 2025-06-18). stdout carries only JSON-RPC; logs go to stderr. Long operations return operation ids; clients poll status and may cancel. `operation_apply` and `operation_resume` take `allow` — approvals for this run, like `--allow`, so a resume needs its own — but never `external`: an agent cannot approve provider effects for itself. An agent-supplied `external` is refused with `GROOT_E_POLICY_DENIED`, and the next step names the terminal command for a person: `groot apply <planId> --allow external` or `groot resume <operationId> --allow external`. `operation_rollback` takes no approvals.

### `groot schema [name]`

Lists contracts (with schema URLs), commands, capabilities and recipes in this build, error ids with exit codes, and the exit-code table; with a name, prints that contract's JSON Schema.

## Action classes and policy

Plans declare the classes of effect they need: `fs.create`, `fs.edit`, `fs.delete`, `fs.move`, `deps.change`, `install`, `generator`, `command`, `network`, `git`, `process`, `external`. `groot.json` `policy.allow` lists what runs without extra approval (default: everything local) — listing `external` there is valid but approves nothing; `policy.external` (`deny` | `ask`) governs effects on provider accounts, which always need an explicit `--allow external` from a human in a terminal and an adapter that supports them — MCP `operation_apply` and `operation_resume` refuse an agent-supplied `external` approval with `GROOT_E_POLICY_DENIED`. A plan file is untrusted: besides the classes it declares, every action type implies its own (`file.write`/`file.edit` need `fs.create` when the path is expected absent, else `fs.edit`; `env.secret` needs `fs.edit`; `command.run` needs `command` unless declared as `install`/`git`/`process`, plus `network` when it uses the network; `deps.add` needs `deps.change`; `generator.run` needs `generator`; deletes and moves need `fs.delete`/`fs.move`). The CLI, MCP tools, and task runners all go through the same executor check. Approvals are per run: `apply` and `resume` each hold the steps they will run to the policy, read fail-closed from `groot.json` (see `groot apply` above). Rollback is not policy-checked: it returns files to their recorded state, and its compensating `bun install --no-save` runs without an approval.

## State files

| Path | Committed | Contents |
| --- | --- | --- |
| `groot.json` | yes | Blueprint v2 (or a v1 manifest until migrated) |
| `groot.lock.json` | yes | Exact generator versions/integrity, recipe versions and dependencies, Groot-owned artifacts with content hashes |
| `.groot/` | no (self-ignoring) | plans (owner-only, known secret values concealed), owner-only operation journals and backups, evidence, tasks, reviews, worktrees, `ref-moves.jsonl` (target-branch fast-forwards made by `task integrate`), the writer lock. Must be a real directory inside the project — a symlinked `.groot`, `.groot/.gitignore`, or state subdirectory is refused with `GROOT_E_PATH_OUTSIDE_PROJECT` |

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
