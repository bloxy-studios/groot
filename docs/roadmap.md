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

## v0.1 — Claim the soil 🌱

- [ ] Publish the `create-groot` skeleton to npm (claims the name, proves the release pipeline end-to-end: provenance, binaries, checksums, installers).
- [ ] `groot --version`, `--help`, stub subcommands pointing at the spec.
- [ ] npm Trusted Publishing (OIDC) configured after first publish.

## v0.2 — `groot init` 🌳

The scaffolding engine, per [cli-spec.md](./cli-spec.md) and [architecture.md](./architecture.md):

- [ ] Resolve → preflight → generate → stitch → verify pipeline.
- [ ] Full matrix: Next.js / SvelteKit (web), Expo (mobile), Elysia / Hono (api), Convex (backend, default).
- [ ] Interactive prompts (clack) + fully non-interactive flag mode.
- [ ] `--dry-run` (+ `--json` plan output), `--dir-conflict` policies.
- [ ] `groot.json` manifest + published JSON schema.
- [ ] E2E scaffold tests in CI (matrix of representative combinations).

## v0.3 — Grow and tend 🌿

- [ ] `groot add <scaffold>` — grow an existing workspace.
- [ ] `groot doctor` — workspace health checks with fixes.
- [ ] Preset support: `groot init --preset <name>` reading a shared groot.json.

## v0.4 — Agent & CI hardening 🤖

- [ ] Stable machine-readable output across all commands (`--json` everywhere).
- [ ] Non-TTY behavior guarantees; scaffold-in-CI documentation.
- [ ] Generator-version pinning matrix with automated upstream-drift detection (scheduled job re-verifies scaffold-flows.md facts).

## v1.0 — Stability contract 🏛️

- [ ] Semver stability for CLI flags, exit codes, `groot.json` schema.
- [ ] Docs site (`apps/docs` — dogfooding a groot-style workspace).
- [ ] Signed binaries (macOS notarization; SBOM + attestations on releases).

## Ideas beyond 1.0 (unscheduled)

- More scaffolds: TanStack Start, Nuxt, tRPC/oRPC pairings, auth add-ons (Better Auth), DB add-ons (Drizzle).
- Community template registry (curated, verified adapters).
- `groot upgrade` — re-run stitch patches after upstream framework upgrades.
- Opt-in, anonymous usage telemetry (never on by default; separate RFC + discussion first).

## How to influence this roadmap

Open a [feature request](https://github.com/bloxy-studios/groot/issues/new?template=feature_request.yml) or [scaffold request](https://github.com/bloxy-studios/groot/issues/new?template=scaffold_request.yml), or start a [Discussion](https://github.com/bloxy-studios/groot/discussions). Roadmap changes land as PRs to this file.
