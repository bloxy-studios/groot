---
"create-groot": minor
---

🌳 v0.2 — `groot init` is real: plant a complete bun-first Turborepo in one command

- **The full pipeline**: resolve (flags + interactive prompts) → preflight → generate → stitch → verify. `bun create groot my-app` produces an installed, git-initialized, coherent workspace.
- **The full scaffold matrix**: Next.js or SvelteKit (`apps/web`), Expo (`apps/mobile`), Elysia or Hono (`apps/api`), Convex (`packages/backend`, default) — orchestrating the official generators with pinned majors, and writing Elysia/Convex directly (including the standard Convex `_generated` stubs, adapted for bun-first workspaces).
- **Coherence out of the box**: bare app package names, one root lockfile, non-conflicting dev ports (Hono/Elysia on 3001), `@repo/backend` workspace links + env placeholders, per-framework turbo build outputs, and a `groot.json` manifest with a published JSON schema.
- **Automation-grade**: `--yes`, `--dry-run` (+ pure-stdout `--json` plan), `--dir-conflict error|merge|increment`, `--no-install`, `--no-git`, `--keep-failed`, spec'd exit codes, and a hard guarantee of never hanging on a prompt in CI.
- Real-generator E2E now runs in CI on every PR and on a weekly upstream-drift cron.

`groot add` and `groot doctor` arrive in v0.3 — the stubs point at the spec and roadmap.
