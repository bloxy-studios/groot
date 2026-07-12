# Roadmap

> Living document — dates are directional, scope is the commitment. Track progress via [milestones](https://github.com/bloxy-studios/groot/milestones) and [releases](https://github.com/bloxy-studios/groot/releases).

## Phase 0 — Production-grade OSS foundation ✅

The repository itself, done right before feature code:

- Governance: README, LICENSE (MIT), CONTRIBUTING, Code of Conduct (Contributor Covenant 3.0), SECURITY, SUPPORT, CODEOWNERS, issue forms, PR template.
- CI: Biome lint/format, typecheck, tests, compile smoke — SHA-pinned actions, least-privilege permissions.
- Security automation: CodeQL, OpenSSF Scorecard, dependency review, Dependabot (bun + actions).
- Release automation: Changesets → npm publish with provenance → compiled binaries (5 platforms) + SHA256SUMS on GitHub Releases.
- Installers: `install.sh` / `install.ps1` with checksum verification.
- Review policy: every PR requires CI green + Greptile 5/5.

## v0.1 — Claim the soil 🌱 ✅ (2026-07-10)

- [x] Publish the `create-groot` skeleton to npm (claims the name, proves the release pipeline end-to-end: provenance, binaries, checksums, installers).
- [x] `groot --version`, `--help`, stub subcommands pointing at the spec.
- [x] npm Trusted Publishing (OIDC) configured after first publish — releases are tokenless with automatic provenance.

## v0.2 — `groot init` 🌳 ✅ (2026-07-10)

The scaffolding engine, per [cli-spec.md](./cli-spec.md) and [architecture.md](./architecture.md):

- [x] Resolve → preflight → generate → stitch → verify pipeline.
- [x] Full matrix: Next.js / SvelteKit (web), Expo (mobile), Elysia / Hono (api), Convex (backend, default).
- [x] Interactive prompts (clack) + fully non-interactive flag mode (`bun create groot my-app` bare-destination form included).
- [x] `--dry-run` (+ `--json` plan output), `--dir-conflict` policies.
- [x] `groot.json` manifest + published JSON schema.
- [x] E2E scaffold tests in CI running the real generators (also on a weekly cron as upstream drift detection — an early slice of v0.4).

## v0.3 — Grow and tend 🌿 ✅ (2026-07-11)

- [x] `groot add <scaffold>` — grow an existing workspace.
- [x] `groot doctor` — workspace health checks with fixes.
- Preset support → moved to v0.4 (v0.3.0 was released before it landed).

## v0.4 — Presets, agents & CI hardening 🤖 ✅ (2026-07-11)

- [x] Preset support: `groot init --preset <path>` reading a shared groot.json as the selections source.
- [x] Stable machine-readable output across all commands (`--json` everywhere): `init --dry-run --json`, `add --dry-run --json`, `doctor --json`.
- [x] Non-TTY behavior guarantees; scaffold-in-CI documentation — process-level contract tests across `init`/`add`/`doctor`, plus [ci.md](./ci.md).
- [x] Generator-version pinning matrix with automated upstream-drift detection — [`drift.yml`](../.github/workflows/drift.yml) re-checks every pinned series + scaffold-flows.md's age weekly and files a self-healing issue ([runbook](./maintainers.md#upstream-drift-watch)).

## v1.0 — Stability contract 🏛️ ✅ (2026-07-12)

- [x] Semver stability for CLI flags, exit codes, `groot.json` schema — [stability.md](./stability.md) defines the covered surface and change rules, tripwired by a contract snapshot test; binding as of v1.0.0.
- [x] Docs site — [groot.dev on GitHub Pages](https://bloxy-studios.github.io/groot/): a dependency-free bun build (`apps/docs`) rendering the normative docs into the [Paper & Ink design system](../apps/docs/DESIGN.md). (Upgrading it to a full groot-scaffolded workspace app is tracked for when the site grows interactive.)
- [x] SBOM + build-provenance attestations on every release — verify with `gh attestation verify <asset> --repo bloxy-studios/groot`.

## Post-1.0 hardening (owner-gated)

Items that need accounts or console access only the owner holds — none of them block releases:

- [ ] macOS notarization — requires an Apple Developer account (owner action; see [maintainers.md](./maintainers.md#release-flow-fully-automated-after-setup)).
- [ ] npm publish-access hardening — tighten the package's publishing access on npmjs.com (trusted publishing only, no tokens); OIDC releases keep working unchanged.

## v1.1 — Grow wider 🌐 ([milestone](https://github.com/bloxy-studios/groot/milestone/1))

New scaffolds and a new slot, drawn from the A-tier of [expansion.md](./expansion.md) — every adapter ships with verified flags in scaffold-flows.md, stitch patches, doctor checks, and E2E coverage:

- [ ] **Desktop slot** (`apps/desktop`): Tauri v2 (`create-tauri-app`, including its official `--ci` wrap-apps/web mode) and Electron (`@quick-start/create-electron`).
- [ ] **Web wave**: TanStack Start, React Router (framework mode), Nuxt, Astro, and plain Vite templates.
- [ ] **API**: Fastify (`fastify-cli generate --lang=ts`, dev script patched to `bun --watch`).
- [ ] **Mobile**: bare React Native (`@react-native-community/cli` with `--pm bun`) with a metro monorepo stitch.
- [ ] **Backend**: Supabase (`supabase init`; Docker/login steps deferred to next-steps output).

## v1.2 — Git & GitHub powers 🐙 ([milestone](https://github.com/bloxy-studios/groot/milestone/2))

- [ ] `groot init --github` (+ `--public`) — create + push via `gh repo create --source=. --push`, with auth detection and graceful printed fallbacks when gh is absent.
- [ ] `--ci` — the official Turborepo bun GitHub Actions recipe (SHA-pinned actions, `turbo --affected`), bundled with a `dependabot.yml` covering the bun and github-actions ecosystems.
- [ ] `--hooks` (opt-in) — lefthook: biome on staged files pre-commit, `turbo lint typecheck --affected` pre-push, installed via the root `prepare` script (bun-safe).

## v1.3 — The agent era 🤖 ([milestone](https://github.com/bloxy-studios/groot/milestone/3))

- [ ] `AGENTS.md` generated from the groot.json manifest + one-line `CLAUDE.md` import shim — regenerated by `groot add` so agent context never rots.
- [ ] A groot `SKILL.md` scaffolded into workspaces (agentskills.io format, readable by Claude Code, Cursor, and Codex).
- [ ] `groot mcp` — a stdio MCP server as a thin adapter over the existing `--json` layer (target: MCP TypeScript SDK v2), plus a scaffolded `.mcp.json`.
- [ ] `llms.txt` + `llms-full.txt` generated by the docs-site build.
- [ ] `apps/agent` slot exploration via `create-mastra` (LangGraph flavor as the alternate).

## v1.4 — The add-on engine 🧩 ([milestone](https://github.com/bloxy-studios/groot/milestone/4))

Add-ons patch *existing* scaffolds instead of owning slots — validated by the research: none of the A-tier candidates has a standalone generator, all are direct-write ([expansion.md](./expansion.md#add-ons-new-concept)):

- [ ] Add-on pipeline design: manifest recording, doctor checks, composition rules.
- [ ] Drizzle ORM add-on (`drizzle-orm/bun-sqlite` zero-infra default; `bun-sql` for Postgres).
- [ ] Better Auth add-on (direct-write + `@better-auth/cli generate --yes`; layers on Drizzle).
- [ ] tRPC add-on for Hono/Elysia apis (oRPC as a second flavor later).

## Ideas beyond (unscheduled)

- Community template registry (curated, verified adapters).
- `groot upgrade` — re-run stitch patches after upstream framework upgrades.
- Opt-in, anonymous usage telemetry (never on by default; separate RFC + discussion first).
- Tier B/C candidates from [expansion.md](./expansion.md) graduate on evidence: Nitro at v3 GA, SolidStart after a prompt-suppression probe, changesets once native bun publish ships, PocketBase/InstantDB on demand.

## How to influence this roadmap

Open a [feature request](https://github.com/bloxy-studios/groot/issues/new?template=feature_request.yml) or [scaffold request](https://github.com/bloxy-studios/groot/issues/new?template=scaffold_request.yml), or start a [Discussion](https://github.com/bloxy-studios/groot/discussions). Roadmap changes land as PRs to this file.
