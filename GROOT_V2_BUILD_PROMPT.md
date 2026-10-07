# Groot v2 — Claude Code Build Prompt

Use this brief when explicitly assigned the Groot v2 refactor or when invoking /groot-v2. Read it completely before implementing. Ordinary maintenance tasks retain their assigned scope.

## Mission

Refactor bloxy-studios/groot into a Bun-first project lifecycle CLI for developers and their coding agents. Groot must create and adopt projects, apply coherent changes, keep agent context current, coordinate bounded agent work, and attach executable evidence to results.

Product line: **Build it. Grow it. Prove it works.**

Execute the work, maintain checkpoints, and continue through the local v2 release gates. Product research and architecture documents are inputs to implementation. Completion requires actual code, a usable CLI, migration guidance, meaningful checks, and reproducible demonstrations.

Read these sources:

- CLAUDE.md and any applicable nested agent instructions.
- GROOT_V2_PRODUCT_PLAN.md: the full product/refactor planning snapshot.
- docs/cli-spec.md and docs/stability.md: existing public contracts.
- docs/architecture.md and docs/scaffold-flows.md: implementation and adapter knowledge.
- docs/expansion.md and docs/roadmap.md: research and outstanding work.
- Current source, tests, release workflows, schemas, issues, and open PRs.

The supplied plan was researched on 30 September 2026 against main at 49eb95f7d835a1d7d101c923c7ffb993e8c0e0bf. Treat that as historical evidence. Inspect the actual checkout and refresh facts that have changed.

## 1. Default decisions and scope

Proceed with these working defaults, documenting their implications:

| Decision | Default |
| --- | --- |
| Audience | Solo developers who use coding agents; small-team compatibility in the architecture |
| First value | Verified setup, integration, and subsequent project evolution |
| Interface | CLI first; interactive choices and machine contracts over the same core |
| Execution | Local, with installed Claude Code and Codex adapters |
| Implementation | Bun, strict TypeScript, ESM, existing repository tooling |
| Topology | Support a genuine single application and a monorepo |
| Writable adoption | Certified Bun/TypeScript repositories first; readable unknown project facts with explicit uncertainty |
| Reference product | An authenticated application with typed persistence and an executable protected flow |
| Release | Reviewable local v2 implementation and prerelease packaging readiness |

Ask a focused choice question when an answer materially changes a consequential product decision. Prefer a recommendation and two or three clear choices. State reasonable defaults and continue independent work. Avoid repeating answered questions or requesting confirmation for routine local implementation.

The local v2 target includes the operation core, verified auth/data capability, context synchronization, a typed MCP facade, and bounded execution through two supported installed-agent adapters. Validate one runner end to end before adding the second.

Broader billing, email, uploads, search, AI applications, background workflows, upgrades, deployment, remote workers, team services, registries, and voice/editor surfaces remain visible in a prioritized expansion ledger. Identify dependencies and add supported recipes as core gates pass. Record explicit release boundaries for these extensions rather than silently promoting every research idea to a launch requirement.

## 2. Working method

1. Inspect git status, current branch, tool versions, current source, documentation, and existing tests.
2. Preserve all unrelated work. Create refactor/groot-v2-core from the current checkout. If that branch exists, inspect its work and continue safely; choose a fresh named worktree when necessary.
3. Run the applicable baseline checks once and distinguish existing failures from regressions.
4. Create docs/v2-research.md, docs/v2-architecture.md, and docs/v2-execution.md before major changes. Keep them short enough to remain useful.
5. Record verified primary sources, versions, dates, uncertain facts, current gaps, scope decisions, dependencies, acceptance criteria, and named work units.
6. Agree on interfaces before parallel implementation. Use available subagents for independent research, core, transforms, capabilities, runners, and verification.
7. Give each agent a bounded task, paths or worktree ownership, prerequisites, and acceptance criteria. Keep schema/contract decisions under one coordinating owner.
8. Integrate incrementally and validate the combined state. A completed subagent message is a progress signal; checked code and evidence determine completion.
9. Persist resumable progress in docs/v2-execution.md: current branch/commit, completed work, next runnable task, checks, blockers, and decisions.
10. Continue after context compaction using those records. Finish the current gate, then proceed to the next gate.

Use simple module boundaries first. Split packages when dependencies, distribution, or ownership justify them. Preserve the existing adapter research and release infrastructure.

## 3. Research requirements

Verify implementation-sensitive behavior against current primary documentation or source, and empirically probe fragile generator flags. In particular, refresh:

- Bun workspace behavior, compiled binary targets, lifecycle trust, and process semantics.
- Framework generator inputs, silence flags, output structure, native prerequisites, and staging behavior.
- Compatibility of the selected web/API/database/auth recipe.
- Claude Code's documented programmatic interfaces and authentication.
- Codex job SDK versus richer app-server integration, including transport support and maturity.
- MCP SDK release/support status, schemas, cancellation, long-running tool operations, and transport behavior.
- ACP support only for adapters that actually implement it.
- Existing project's v1 stability, schemas, JSON output, and exit codes.

Record exact evidence rather than reusing dated predictions. Choose supported releases based on the current research; avoid hardcoded assumptions about future model capabilities.

## 4. Domain model and architecture

Define versioned contracts for:

| Concept | Required meaning |
| --- | --- |
| Project | Repository identity, topology, apps/packages/services, toolchains, observations |
| Capability | A product or operational result, with dependencies and supported recipes |
| Blueprint | Desired structure, capabilities, decisions, conventions, verification contracts |
| Operation | Concrete planned actions, preconditions, policies, progress, recovery, result |
| Evidence | Check outcome, command/tool, scope, revision, environment, timing, artifacts, limitations |

Keep observed repository state separate from desired blueprint state. Give inferred facts provenance, confidence, and freshness. Give human-confirmed decisions explicit authority. Explain contradictions rather than merging them silently.

Distinguish agents used by developers from agents embedded in a deployed application. Distinguish application frameworks, provider services, toolchains, and product capabilities.

Separate responsibilities into CLI presentation, discovery, compatibility/planning, transformations, execution/journal, adapters, verification, context, and protocol surfaces. All surfaces must call the same core operations and policy enforcement.

Use a portable versioned blueprint, a recipe/generator resolution lock, and local operation state. Choose JSON/files or Bun SQLite according to recovery/query needs; justify the choice. The CLI must remain usable without a Groot cloud account.

## 5. CLI and compatibility

Implement or refine the following surfaces with a documented contract:

| Surface | Required behavior |
| --- | --- |
| init / add / doctor | Preserve v1 behavior through a tested compatibility path |
| inspect | Read-only discovery; report supported, inferred, and unknown facts |
| adopt | Preview and register supported existing projects while preserving layouts |
| plan | Resolve init/add/change operations with concrete actions and preconditions |
| apply | Execute a validated plan according to its operation policy |
| verify | Run declared structural/build/runtime/product-flow checks |
| status | Show project, operation, task, blocker, and evidence state |
| resume | Continue interrupted operations from valid checkpoints |
| rollback | Preview and execute safe recorded recovery or compensating actions |
| context | Return concise task-specific knowledge and synchronize managed instructions |
| task / review | Create/run/inspect bounded agent work and review change sets |
| mcp | Expose typed core operations to MCP clients |

The plan's illustrative syntax may be refined where evidence favors a better contract. Update documentation and schema examples together. Add ergonomic one-step commands only as wrappers over the same plan/execution path.

Machine behavior:

- Publish versioned input, plan, event, result, and error schemas.
- Keep stdout exclusively for the selected JSON or protocol output; send progress to stderr.
- Define stable error identifiers, exit behavior, interruption, timeouts, and prompt-free non-TTY execution.
- Return structured blocked decisions rather than hanging for input.
- Include project/plan/operation/task identifiers and evidence references.
- Keep large logs addressable and secret-redacted.
- Add schema/command discovery for agents.
- Preserve documented v1 flags, output, and exit codes in the compatibility path.
- Make schema migration explicit, deterministic, and previewable; reject unsupported versions.
- Document deliberate v2 changes under major-version semantics and show rollback limits.

## 6. Discovery and adoption

Read supported manifests/configuration statically. Avoid executing arbitrary repository configuration during discovery.

Detect current package manager, topology, package names, application boundaries, scripts, framework versions, toolchain requirements, existing agent files, and likely capabilities. Distinguish facts from guesses.

For writable adoption, show the planned blueprint/metadata and ownership rules before changing anything. Preserve custom directory names, scripts, configuration, staged changes, and human files. Repository rearrangement is a separate operation.

Resolve paths consistently and constrain writes to declared project/workspace boundaries, including symlink behavior. Record unsupported arrangements precisely and offer an actionable supported path.

Support a real single-app topology as well as apps/packages monorepos. Keep discovery extensible to native, Rust, Python, Flutter, and other targets without claiming uncertified writable support.

## 7. Plan, transformations, and recovery

Every plan must enumerate:

- Selected capabilities and dependency/conflict resolution.
- Exact generator/recipe/adapter artifacts and integrity information where available.
- File creates, structured edits, moves, deletes, dependency changes, and commands.
- Expected ownership, affected precondition fingerprints, and permitted action classes.
- Environment contracts and external service effects.
- Required verification, acceptance criteria, and evidence collection.
- Recovery behavior, irreversible effects, and unsupported assumptions.

Use structured JSON/TOML edits, managed text regions, and supported parser/codemod transforms for source edits. Preserve surrounding custom content. Return a useful conflict when a safe match cannot be established.

Stage generator output, inspect it, and apply only after preconditions pass. Mark unpredictable upstream output clearly; offer staged preview where feasible.

Implement operation-level writer coordination, atomic checkpoint persistence, idempotent steps, interruption handling, bounded retries, and deterministic recovery. Track artifacts owned by Groot separately from user data.

A human edit after planning should invalidate the affected precondition. A rollback after later edits should return a conflict rather than overwrite that work. Keep unrelated completed work intact when replanning.

Filesystem rollback restores only safely recorded owned changes. Remote actions need provider-supported idempotency and compensating operations. Reflect actual limits in CLI output.

Record intent before executing a step, and reconcile actual outcomes after interruptions. Prevent duplicate commands or remote effects when execution resumes. Test interruption around write/checkpoint boundaries.

## 8. Certified capability engine

Define one recipe contract for requirements, conflicts, versions, transforms, environment contracts, verification, optional external setup, and recovery.

Generalize the existing framework adapters without discarding their verified quirks: staging, native prerequisites, upstream-generated git cleanup, backend type placeholders, workspace wiring, and lifecycle requirements.

Implement exact artifact resolution and a lock. Support deterministic configuration and operation replay within stated constraints. If offline artifacts are unavailable, report the missing artifacts rather than suggesting an offline guarantee.

Allocate dev ports across the selected apps and update coupled URLs/configs. Preserve user-selected ports where possible; detect runtime occupancy separately from blueprint collisions.

Environment contracts identify each variable's consumer, scope, public/server visibility, requirement, and safe storage location. Never expose server secrets through public prefixes or generated context. Place values where the actual framework consumes them.

### Required reference flow

Research and choose a compatible web, API where needed, database, and authentication combination. A candidate is Next.js or a Bun API with Drizzle, a locally testable database, and Better Auth; certify the actual composition before committing to it.

Prove the flow twice:

1. Create a fresh supported project.
2. Adopt a representative customized supported project.

In each case, add the capability, install required dependencies, run build checks, launch the app, create/authenticate a user, execute a protected database operation, and show that an unauthorized request fails.

Verify session behavior and the chosen recipe's authorization boundary. Tests must exercise actual wiring rather than merely checking file existence. Use temporary databases/data and clean up owned test processes.

A placeholder type file may pass structural checks. Report configured-service and live product-flow evidence separately.

## 9. Context and instruction synchronization

Generate concise managed sections in AGENTS.md and Claude-compatible instructions from the current blueprint and discovery facts. Verify each supported host's actual discovery and import rules.

Preserve human content and precedence. Track ownership of generated regions. Provide previewable synchronization, conflict detection, source provenance, and invalidation when files change.

Task context should include only relevant applications, interfaces, decisions, conventions, commands, environment variable names, acceptance checks, and known gaps. Keep secret values and private session state out.

Provide a Groot skill that teaches plan/apply/verify and workspace workflows. Install or emit host-specific locations/configuration according to researched support. Keep source knowledge canonical and generate host projections to reduce drift.

Expose evidence and architecture decisions as retrievable artifacts rather than continuously growing transcripts. Accept portable task handoffs while respecting provider-specific session boundaries.

## 10. Installed-agent execution

Implement a common runner contract and truthful capability discovery: installed executable/version, supported authentication, structured events, cancellation, session continuation, permissions, usage reporting, and working directory isolation.

Use documented Claude Code and Codex interfaces. Use vendor job APIs for batch tasks and richer interfaces only where the interaction needs them. ACP is an additional adapter path where actually supported. MCP gives agents tools; it does not provide universal session orchestration.

Each task has an objective, explicit dependencies, file/worktree ownership, allowed capabilities, acceptance criteria, runtime limits, status, and evidence. States include pending, running, blocked, interrupted, failed, awaiting review, and completed.

Use worktrees for independent code changes. Worktrees provide editing isolation; execution sandboxes enforce process/filesystem/network capabilities where available.

Default to bounded parallelism. Serialize operations that mutate shared state. Detect overlapping task ownership and validate integrated changes afresh.

Implement interruption, process-tree cleanup, bounded retries, and session continuation according to each adapter's actual capabilities. Reuse supported login flows. Groot must not extract another application's stored credentials or bypass its credential controls.

Distinguish observed cost, estimated cost, subscription usage, and unavailable usage data. Enforce provider-supported spend/token limits and local concurrency/wall-time limits.

If a real CLI login or environment is unavailable, complete adapter contracts and meaningful process tests, then report real-run verification as blocked. Keep unaffected work moving. A simulated runner can test protocol contracts but must be labeled as such.

Validate one real runner through task, edit, verification, review, and integration before adding the second.

## 11. MCP and human interaction

Expose schemas/discovery, project facts, plans, operation execution/status, evidence, and task/review operations as appropriate typed tools/resources. Call the shared core directly; avoid reparsing presentation text or duplicating policy logic.

Keep stdio protocol output clean. Support cancellation. For long operations, return addressable operation state or use supported progress/task behavior so clients can recover after timeouts.

Human prompts should resolve meaningful choices. Show concrete effects, a recommendation, and tradeoffs. Honor already granted scope and configuration. Make conflicts, blocked setup, and verification failures actionable.

Provide clear CLI inspection of plan diffs, task state, review results, evidence, and recovery. A richer terminal dashboard can be added over this same state once the core workflow demonstrates its value.

## 12. Expansion ledger

Keep the complete product catalogue from GROOT_V2_PRODUCT_PLAN.md and classify each item by dependency, priority, support level, and evidence required.

Evaluate these directions as the core stabilizes:

- Billing/entitlements, roles, organizations, email, uploads, search, and observability.
- Background jobs, durable workflows, AI application recipes, and evaluation harnesses.
- Framework upgrades, codemods, drift detection, and targeted repair.
- CI diagnosis/repair, deployment adapters, preview environments, and isolated preview data.
- Shared team blueprints/policies, recipe distribution, and provenance.
- Hosted workers/sandboxes, native API execution, provider routing, and richer credential brokerage.
- Native/mobile/desktop targets and editor/voice integration.

For each shipped extension, require a certified composition and executable flow. For each deferred extension, retain a concrete dependency and acceptance plan. Provider accounts and production operations remain subject to the configured action policy and actual authorization.

## 13. Release gates

| Gate | Exit criteria |
| --- | --- |
| A. Baseline and contract | Reproducible baseline, refreshed research, tested v1 compatibility, executable scope |
| B. Operation core | Discovery/adoption, models, locks, compatibility solver, plan/apply, safe transformations, journal/recovery |
| C. Verified product | Fresh and adopted auth/data flow, truthful evidence, ports/environment contracts, managed context |
| D. Agent interface | Typed MCP, one real runner, then a second, task dependencies/worktrees/review/integration |
| E. Local release readiness | Compiled CLI demos, docs/schema alignment, migration/recovery guidance, changesets, reviewable changes |

Keep progress through these gates. Resource limits or a compacted session require a checkpoint and continuation. External blockers should be isolated and documented precisely.

### Required acceptance evidence

- Legacy command compatibility and v1-to-v2 schema handling.
- Genuine single-app and monorepo creation.
- Adoption preserving a customized project and dirty/staged content.
- Compatibility conflicts refused during planning.
- Planned edits and exact artifact resolution recorded.
- Reapplying a completed plan causing no duplicate effects.
- Stale plans and later human edits producing narrow conflicts.
- Recovery from a deliberately interrupted operation.
- Concurrent writers/tasks handled consistently.
- Managed instruction synchronization preserving human sections.
- Authorized and unauthorized product-flow checks against real wiring.
- Prompt-free JSON CLI process behavior and protocol-clean MCP.
- Installed-agent task lifecycle, interruption/continuation where supported, review, and integrated verification.
- Unsupported native prerequisites or missing credentials reported as blocked/skipped with reasons.
- Results tied to the revision/environment that was actually checked.

## 14. Validation and repository requirements

Follow the existing Bun/TypeScript/ESM, Biome, conventional commit, changeset, SHA-pinned CI, least-privilege, installer checksum, and Greptile requirements.

Run meaningful tests appropriate to each change. Prioritize contracts, migrations, stale plans, ownership conflicts, interruptions, recovery, writer coordination, CLI process behavior, generator integration, product flows, and runner protocols.

Keep structural doctor checks fast and offline. Make deeper verification profiles explicit. Distinguish process mocks used for contract checks from real end-to-end evidence.

Run repository lint, typecheck, tests, and build at the relevant integration points. Execute the compiled binary for reproducible CLI scenarios. Exercise supported native/platform behavior through appropriate CI; record unavailable platforms rather than claiming they were tested locally.

Fix failures without weakening acceptance criteria or turning real flows into file-existence checks. Document baseline failures independently.

Update normative CLI, architecture, schema, generator, CI, stability, roadmap, and user documentation alongside behavior changes. Add appropriate changesets. Make README/product descriptions match the implemented release.

Prepare reviewable commits and a draft PR. Apply existing review rules and address or reasonedly rebut findings. Publishing packages, merging into main, provisioning paid resources, or changing production require explicit authorization.

## 15. Final delivery

Return a concise report with:

1. Implemented capabilities and their support/certification matrix.
2. Reproducible install, compiled CLI, creation/adoption, capability, verification, recovery, and agent-task commands.
3. Test and live-flow evidence, including the checked revision/environment.
4. Migration, custom-edit preservation, and recovery guidance.
5. Review links and required review outcomes.
6. External blockers with the exact missing prerequisite and affected scope.
7. The prioritized expansion ledger and next executable tasks.

Completion claims must match evidence. A stub, unchecked claim, skipped verification, missing login, or unavailable service remains visible as a limitation. Continue working on unaffected scope until every local release gate is satisfied.

## Ready-to-paste goal

GROOT_V2_GOAL.md contains the complete short invocation, under 4,000 characters including /goal. If the installed Claude Code build or extension does not provide /goal, paste its body as a normal task or invoke the project command /groot-v2.

The project command loads this brief only when explicitly invoked. User-supplied focus or constraints take precedence over the default scope.
