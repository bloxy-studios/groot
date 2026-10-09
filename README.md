<div align="center">

# 🌱 groot

**Plant a bun-first Turborepo. Grow the apps you actually want.**

[![npm](https://img.shields.io/npm/v/create-groot?logo=npm&color=cb0000)](https://www.npmjs.com/package/create-groot)
[![npm downloads](https://img.shields.io/npm/dm/create-groot?logo=npm&color=cb0000)](https://www.npmjs.com/package/create-groot)
[![GitHub stars](https://img.shields.io/github/stars/bloxy-studios/groot?logo=github&color=e3b341)](https://github.com/bloxy-studios/groot/stargazers)
[![CI](https://github.com/bloxy-studios/groot/actions/workflows/ci.yml/badge.svg)](https://github.com/bloxy-studios/groot/actions/workflows/ci.yml)
[![CodeQL](https://github.com/bloxy-studios/groot/actions/workflows/codeql.yml/badge.svg)](https://github.com/bloxy-studios/groot/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/bloxy-studios/groot/badge)](https://scorecard.dev/viewer/?uri=github.com/bloxy-studios/groot)
[![License: MIT](https://img.shields.io/badge/License-MIT-brightgreen.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun%20%E2%89%A5%201.2-f9f1e1)](https://bun.sh)

</div>

---

> 🌱 **v2 is in prerelease** (`bunx create-groot@next`). It adds adoption of existing projects, previewable capability plans, journaled apply/resume/rollback, evidence-based verification, managed agent instructions, tasks for installed coding agents, and an MCP server — see [what's new](#v2-create-adopt-evolve-verify).
>
> 🏛️ **v1 is stable** (`bunx create-groot@latest`). The [stability contract](./docs/stability.md) is binding: the command set, every documented flag, exit codes, and the `groot.json` schema follow semver. v2 keeps every v1 command, flag, and exit code; its deliberate changes are listed in [stability.md](./docs/stability.md#version-2-deliberate-changes).

## What is groot?

groot is a Bun-first CLI for humans and coding agents that **creates, adopts, evolves, and verifies products**.

It started as a scaffolder, and that is still its foundation: it **plants a [Turborepo](https://turborepo.com) monorepo (or a single app) and grows it with the apps you pick** — a web app, a mobile app, a desktop app, an API, and a backend — in one command. Instead of shipping its own frozen templates, groot **orchestrates each framework's official generator** (`create-next-app`, `sv create`, `create-expo-app`, `create-tauri-app`, `create-hono`, …) and then **stitches the results into one coherent bun workspace**: shared config packages, workspace protocol dependencies, non-conflicting dev ports, a clean root `turbo.json`, and a single lockfile.

| Slot        | Options at v1.1                          | Where it lands        |
| ----------- | ---------------------------------------- | --------------------- |
| 🌐 Web      | **Next.js** · SvelteKit · TanStack Start · Astro · React Router · Nuxt · Vite | `apps/web` |
| 📱 Mobile   | **Expo** · React Native (bare)           | `apps/mobile`         |
| 🖥️ Desktop | **Tauri** · Electron                     | `apps/desktop`        |
| ⚡ API      | **Elysia** · Hono · Fastify              | `apps/api`            |
| 🗄️ Backend | **Convex** (default) · Supabase          | `packages/backend`    |

Everything runs on **Bun** — the workspace groot creates uses `bun install`, `bun run`, and Turborepo tasks end to end.

## Quick start

```sh
# with bun (recommended)
bun create groot my-app

# or explicitly
bunx create-groot@latest init my-app
```

Or install the standalone `groot` binary (no Bun required to run it):

```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/bloxy-studios/groot/main/install.sh | bash

# Windows (PowerShell)
powershell -c "irm https://raw.githubusercontent.com/bloxy-studios/groot/main/install.ps1 | iex"
```

Then answer a few prompts:

```text
🌱 groot v1.0.0 — plant a bun-first Turborepo and grow it.

◆  Web app?      › Next.js
◆  Mobile app?   › Expo
◆  Desktop app?  › Skip
◆  API?          › Elysia
◆  Backend?      › Convex

◇  Planting turborepo trunk…
◇  Growing apps/web (Next.js)…
◇  Growing apps/mobile (Expo)…
◇  Writing apps/api (elysia)…
◇  Writing packages/backend (convex)…
◇  Stitching workspace…
◇  Installing workspace (bun install)…
◇  Initializing git repository…

🌳 I am groot — your workspace is planted.
```

Fully non-interactive for CI and agents:

```sh
bunx create-groot@latest init my-app \
  --web next --mobile expo --api elysia --backend convex --yes
```

## Commands

| Command | What it does |
| --- | --- |
| `groot init [dir]` | Plant a new workspace — interactive, or fully flag-driven (`--dry-run --json` for agents); `--topology single` plants one app at the project root (v2) |
| `groot add <scaffold>` | Grow an existing workspace: `groot add hono`, `groot add sveltekit --path apps/marketing` (v2 workspaces get a free dev port automatically) |
| `groot init my-app --github` | Plant, then create + push a private GitHub repo via `gh` (`--public` for public); absent/unauthenticated gh degrades to printed steps |
| `groot doctor` | Health checks with suggested fixes — ports, lockfiles, manifests, per-framework invariants |

The full contract — every flag, exit code, and the `groot.json` manifest schema — lives in [docs/cli-spec.md](./docs/cli-spec.md); [docs/stability.md](./docs/stability.md) defines what's covered by semver (binding since v1.0). Running groot in CI or from an agent? Recipes in [docs/ci.md](./docs/ci.md).

## v2: create, adopt, evolve, verify

v2 (prerelease) turns every change into a **plan you can read before anything is written**, executes it with a **journal you can resume or roll back**, and proves the result with **evidence tied to the exact revision it checked**.

```sh
bunx create-groot@next init my-api --topology single --api hono --yes
cd my-api

groot plan add auth          # data (Drizzle + SQLite) is added first — auth requires it
groot apply <planId>         # journaled; refuses if a file it touches changed since planning
groot verify --profile all   # structural · build · runtime · product-flow (sign-up → protected data → 401)
groot context sync           # managed AGENTS.md / CLAUDE.md sections + the groot skill
```

Already have a project? `groot inspect` reads it without executing anything, and `groot adopt` registers it — writing only `groot.json` and `groot.lock.json`, never moving your files or touching dirty or staged work.

| Command | What it does |
| --- | --- |
| `groot inspect` · `groot adopt` · `groot migrate` | Read-only discovery · register an existing project · explicit v1 → v2 `groot.json` migration |
| `groot plan add <capability>` · `groot plan context-sync` | Preview every file write/edit, dependency, command, environment variable, verification, and recovery limit — nothing changes yet |
| `groot apply <plan>` · `groot status` · `groot resume <op>` · `groot rollback <op>` | Execute with stale-plan detection, one writer at a time, crash-safe resume, and rollback that refuses to overwrite your later edits |
| `groot verify` · `groot evidence` | Run verification profiles and inspect the recorded, redacted evidence |
| `groot context [--task "…"]` · `groot context sync` | Task-scoped project knowledge (variable names, never values) · managed agent instructions that preserve your own text |
| `groot task …` · `groot review <id>` | Hand bounded work to an installed coding agent (Claude Code; Codex adapter included) in an isolated worktree, review it, integrate it with fresh checks |
| `groot mcp` | The same operations as typed MCP tools over stdio, for any MCP client |
| `groot schema [name]` | Machine-readable contracts for every `--json` document |

Certified capabilities: **data** (`data.drizzle-sqlite`) and **auth** (`auth.better-auth`, email + password with protected example data) on Hono + Bun, in single-app and monorepo projects, created or adopted. Everything with `--json` returns one result envelope with stable `GROOT_E_*` error ids. The normative v2 contract is [docs/v2-cli-spec.md](./docs/v2-cli-spec.md); the design is [docs/v2-architecture.md](./docs/v2-architecture.md); what is shipped versus planned is tracked in the [v2 ledger](./docs/v2-ledger.md).

## How it works

1. **Generate** — groot runs each framework's *official* generator with pinned, non-interactive flags. No vendored templates, so scaffolds never rot behind upstream.
2. **Stitch** — groot patches the output into monorepo shape: workspace globs, `@repo/*` package names, shared TypeScript config, deterministic dev ports, merged `.gitignore`, one root lockfile.
3. **Verify** — structural checks and the root install prove the workspace coheres; `groot doctor` re-runs health checks on any groot workspace, any time, with suggested fixes.

Read the full design in [docs/architecture.md](./docs/architecture.md) and each generator's verified flags in [docs/scaffold-flows.md](./docs/scaffold-flows.md).

## Why not just create-turbo?

`create-turbo` plants an excellent tree — two Next.js apps and shared packages. groot is for when your monorepo needs to look like *your product* on day one: Next.js **and** Expo **and** an Elysia API **and** a Convex backend, already wired together, with the boilerplate decisions (ports, package names, shared configs) made consistently. groot uses `create-turbo` under the hood for the trunk, then grows the branches.

## Project status

- [x] **Phase 0** — production-grade OSS repository: CI, CodeQL, OpenSSF Scorecard, release automation, signed provenance, this documentation.
- [x] **v0.1** — `create-groot` published to npm (OIDC provenance), 5-platform binaries + checksum-verified installers live.
- [x] **v0.2** — `groot init` with the full scaffold matrix: the resolve → preflight → generate → stitch → verify pipeline, interactive + fully non-interactive, `--dry-run --json`, real-generator E2E in CI.
- [x] **v0.3** — `groot add` (grow an existing workspace, with occupancy rules and targeted rollback) and `groot doctor` (health checks with fixes).
- [x] **v0.4** — `init --preset`, stable `--json` everywhere, tested non-TTY guarantees, automated upstream-drift detection (weekly pin/doc watch + real-generator E2E cron).
- [x] **v1.0** — the [stability contract](./docs/stability.md) goes binding: CLI surface, exit codes, and manifest schema under semver — plus SBOM + build-provenance attestations on every release and the live docs site.
- [ ] **v2.0** (prerelease `next`) — adopt existing projects, previewable plans with journaled apply/resume/rollback, certified auth + data capabilities with product-flow evidence, managed agent instructions, installed-agent tasks with review and integration, and an MCP server. Progress and remaining gates: [v2 ledger](./docs/v2-ledger.md).

Details in [docs/roadmap.md](./docs/roadmap.md) — or browse everything on the [docs site](https://bloxy-studios.github.io/groot/).

## Contributing

PRs are very welcome — especially [scaffold adapters](https://github.com/bloxy-studios/groot/issues/new?template=scaffold_request.yml) for new frameworks. Start with [CONTRIBUTING.md](./CONTRIBUTING.md). Every PR is reviewed by CI **and** by [Greptile](https://greptile.com); merges require a 5/5 review score.

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). Security issues? See [SECURITY.md](./SECURITY.md) — never open a public issue for a vulnerability.

## Star History
<a href="https://www.star-history.com/?repos=bloxy-studios%2Fgroot&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bloxy-studios/groot&type=date&theme=dark&legend=top-left&sealed_token=pt5O3VmEwWzt5Aohk5h-0AETkiY5VHy4pGXOyEdvA2CkNbqZgDDlLIQQOoTF8o7sBUOKFUfLIat5Mys04vCP5kDgsHq-Wqvo-NVyIzZPw8-hufF6ENY8PeN2wBowKbgo1eV1Lo54BpUIUEgdk2cEVPsICVUktctgx84ohODEffQUTp8P-2Of1KniqpZJ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bloxy-studios/groot&type=date&legend=top-left&sealed_token=pt5O3VmEwWzt5Aohk5h-0AETkiY5VHy4pGXOyEdvA2CkNbqZgDDlLIQQOoTF8o7sBUOKFUfLIat5Mys04vCP5kDgsHq-Wqvo-NVyIzZPw8-hufF6ENY8PeN2wBowKbgo1eV1Lo54BpUIUEgdk2cEVPsICVUktctgx84ohODEffQUTp8P-2Of1KniqpZJ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bloxy-studios/groot&type=date&legend=top-left&sealed_token=pt5O3VmEwWzt5Aohk5h-0AETkiY5VHy4pGXOyEdvA2CkNbqZgDDlLIQQOoTF8o7sBUOKFUfLIat5Mys04vCP5kDgsHq-Wqvo-NVyIzZPw8-hufF6ENY8PeN2wBowKbgo1eV1Lo54BpUIUEgdk2cEVPsICVUktctgx84ohODEffQUTp8P-2Of1KniqpZJ" />
 </picture>
</a>

## License

[MIT](./LICENSE) © 2026 Bloxy Studios

---

<div align="center"><sub><em>"I am groot."</em> — every monorepo, eventually</sub></div>
