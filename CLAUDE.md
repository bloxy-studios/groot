# CLAUDE.md — agent guide for the groot repository

groot is a **Bun-only** TypeScript CLI (npm package: `create-groot`) that scaffolds bun-first Turborepo monorepos by orchestrating official framework generators (create-turbo, create-next-app, sv, create-expo-app, create-hono, Convex) and stitching the output into one workspace. This repo is itself a bun + Turborepo workspace.

## Golden rules

1. **Bun only. Never use npm, npx, yarn, or pnpm in this repo.**
   - install: `bun install` · run scripts: `bun run <script>` · exec tools: `bunx <tool>` · tests: `bun test`
2. **Biome, not ESLint/Prettier.** Format & lint with `bun run format` (fix) / `bun run lint` (check). Don't hand-format against Biome.
3. **Changesets are mandatory** for changes affecting the published package or installers: `bunx changeset`. Docs/CI/test-only changes skip it.
4. **GitHub Actions must stay SHA-pinned** (full 40-char commit SHA + `# vX.Y.Z` comment) with least-privilege `permissions:`. Never interpolate `${{ github.event.* }}` into `run:` — route through `env:`.
5. **Conventional Commits** for commits and PR titles (squash merge): `feat(cli): …`, `fix(installer): …`, `docs: …`, `ci: …`.
6. **Every PR must reach a 5/5 Greptile score.** After pushing fixes, comment `@greptileai` to trigger re-review. Fix or explicitly rebut every review comment.

## Commands

```sh
bun install            # install workspace deps
bun run lint           # biome ci (lint + format check)
bun run format         # biome check --write (auto-fix)
bun run typecheck      # tsc --noEmit via turbo
bun run test           # bun test via turbo
bun run build          # compile CLI binary via turbo (packages/cli/dist/groot)
bunx changeset         # add a changeset
```

## Layout

- `packages/cli/` — the `create-groot` package. Entry: `src/index.ts` (citty-based). Tests: `src/*.test.ts` (bun test).
- `docs/` — **normative docs**: `cli-spec.md` (command surface/flags — the contract), `architecture.md` (generate → stitch → verify pipeline, adapter contract), `scaffold-flows.md` (verified generator flags — update when upstream generators change), `roadmap.md`, `maintainers.md`.
- `.github/workflows/` — ci, codeql, scorecard, dependency-review, release (changesets → npm with provenance → compiled binaries + SHA256SUMS).
- `install.sh` / `install.ps1` — standalone binary installers. Security-critical: checksum verification must never be weakened.

## Style specifics

- TypeScript strict; ESM only (`"type": "module"`); Bun APIs allowed (this package never runs on Node).
- CLI framework is **citty**; interactive prompts (when implemented) use **@clack/prompts**; colors via **picocolors**.
- Keep runtime deps minimal — justify any new dependency in the PR.
- `console.log` is fine (it's a CLI); prefer the shared output helpers once they exist.

## When adding a scaffold adapter

1. Verify the upstream generator's current non-interactive flags — then document them in `docs/scaffold-flows.md` with source links and a verification date.
2. Follow the adapter contract in `docs/architecture.md` (silence flags → run → post-patch list).
3. Add tests for the patch functions; update `docs/cli-spec.md` if flags change.
