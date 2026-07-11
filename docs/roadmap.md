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

## v1.0 — Stability contract 🏛️

- [x] Semver stability for CLI flags, exit codes, `groot.json` schema — [stability.md](./stability.md) defines the covered surface and change rules, tripwired by a contract snapshot test; the guarantee becomes binding at v1.0.0.
- [x] Docs site — [groot.dev on GitHub Pages](https://bloxy-studios.github.io/groot/): a dependency-free bun build (`apps/docs`) rendering the normative docs into the [Paper & Ink design system](../apps/docs/DESIGN.md). (Upgrading it to a full groot-scaffolded workspace app is tracked for when the site grows interactive.)
- [x] SBOM + build-provenance attestations on every release — verify with `gh attestation verify <asset> --repo bloxy-studios/groot`.
- [ ] macOS notarization — requires an Apple Developer account (owner action; see [maintainers.md](./maintainers.md#release-flow-fully-automated-after-setup)).

## Ideas beyond 1.0 (unscheduled)

- More scaffolds: TanStack Start, Nuxt, tRPC/oRPC pairings, auth add-ons (Better Auth), DB add-ons (Drizzle).
- Community template registry (curated, verified adapters).
- `groot upgrade` — re-run stitch patches after upstream framework upgrades.
- Opt-in, anonymous usage telemetry (never on by default; separate RFC + discussion first).

## How to influence this roadmap

Open a [feature request](https://github.com/bloxy-studios/groot/issues/new?template=feature_request.yml) or [scaffold request](https://github.com/bloxy-studios/groot/issues/new?template=scaffold_request.yml), or start a [Discussion](https://github.com/bloxy-studios/groot/discussions). Roadmap changes land as PRs to this file.
