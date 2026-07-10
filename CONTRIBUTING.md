# Contributing to groot

Thanks for helping groot grow! 🌱 This guide covers everything from first clone to merged PR. By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

groot is a **Bun-only** project. You need:

- [Bun](https://bun.sh) **≥ 1.2** (`curl -fsSL https://bun.sh/install | bash`)
- Git

That's it — no Node toolchain required for development. **This repo is strictly Bun-only: npm, npx, yarn, and pnpm are never used here.** If you're coming from npm, these are the Bun equivalents to reach for instead:

| Coming from npm? Don't run… | Run this instead   |
| --------------------------- | ------------------ |
| `npm install`               | `bun install`      |
| `npm run <script>`          | `bun run <script>` |
| `npx <tool>`                | `bunx <tool>`      |
| `npm test`                  | `bun test`         |

The one sanctioned exception is npm **registry administration** (the one-time first publish and token management), which uses the registry's own tooling — see [docs/maintainers.md](./docs/maintainers.md). Day-to-day publishing happens in CI, never on a laptop.

## Getting set up

```sh
git clone https://github.com/<your-fork>/groot.git
cd groot
bun install
```

Verify your environment before you start:

```sh
bun run lint       # Biome (lint + format check)
bun run typecheck  # TypeScript, via turbo
bun run test       # bun test, via turbo
bun run build      # compiles the CLI binary (smoke test)
```

## Repository layout

```
groot/
├── packages/cli/        # the create-groot package (published to npm)
│   └── src/             # CLI source — TypeScript, run by Bun directly
├── docs/                # architecture, CLI spec, scaffold flows, roadmap
├── .github/workflows/   # CI, CodeQL, Scorecard, dependency review, release
├── .changeset/          # changesets config + pending release notes
├── install.sh           # curl installer (Linux/macOS)
├── install.ps1          # PowerShell installer (Windows)
└── scripts/             # maintainer tooling (repo setup, etc.)
```

## Making changes

### 1. Branch

Branch from `main`. Suggested naming: `feat/…`, `fix/…`, `docs/…`, `ci/…`, `chore/…`.

### 2. Code style

- **Biome** handles formatting and linting — run `bun run format` to auto-fix. CI runs `biome ci` and will fail on drift. No ESLint, no Prettier.
- **TypeScript strict mode** — the CLI package typechecks with `tsc --noEmit`. No `any` unless there is truly no alternative (and a comment explaining why).
- Keep the CLI's runtime dependencies minimal; every new dependency needs a justification in the PR description.

### 3. Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): add --dry-run flag to init
fix(installer): handle musl detection on Alpine
docs(scaffold-flows): update sv create flags for 0.17
ci: bump pinned action SHAs
```

PRs are squash-merged, so the **PR title must also follow this format** — it becomes the commit on `main`.

### 4. Changesets (required for anything user-facing)

Any change that affects the published `create-groot` package or the installers needs a changeset:

```sh
bunx changeset
```

Pick the bump (pre-1.0 guidance: breaking → `minor`, features → `minor`, fixes → `patch`) and write a user-facing sentence — it becomes the changelog entry. Docs-only, CI-only, and test-only changes don't need one.

### 5. Tests

- Every bug fix gets a regression test; every feature gets coverage of its happy path and its most likely failure.
- Tests live next to the code (`*.test.ts`) and run with `bun test`.

### 6. GitHub Actions & installer changes (security-critical)

If you touch `.github/workflows/`, `install.sh`, `install.ps1`, or `scripts/`:

- Every action **must be pinned to a full commit SHA** with a `# vX.Y.Z` comment.
- Workflow permissions stay least-privilege: `contents: read` at the top, elevate per job only.
- Never interpolate untrusted input (`${{ github.event.* }}`) into `run:` scripts — pass it through `env:` instead.
- Installer scripts must verify checksums before installing anything.

## Pull request process

1. Fill in the PR template — including how you tested.
2. **CI must be green**: lint, typecheck, tests, compile smoke, CodeQL, dependency review.
3. **Greptile must score the PR 5/5.** Every PR is automatically reviewed by [Greptile](https://greptile.com) when opened, and re-reviewed on every push. The review includes a confidence score out of 5:
   - Read every comment. For each one, either **fix it** or **reply explaining why it's intentional**.
   - Push your fixes — Greptile re-reviews automatically. (Comment **`@greptileai`** any time you want an extra manual pass.)
   - Repeat until the score is **5/5**. A maintainer may override a sub-5 score only with a written justification in the PR.
4. A maintainer reviews and squash-merges. `main` is protected: PRs only, required status checks, no force pushes.

## Release process (maintainers)

Releases are fully automated with [Changesets](https://github.com/changesets/changesets):

1. Merged changesets accumulate on `main`; the release workflow maintains a **"Version Packages"** PR.
2. Merging that PR publishes `create-groot` to npm (with provenance), tags the release, creates a GitHub Release, and attaches compiled `groot` binaries for 5 platforms plus `SHA256SUMS.txt`.

See [docs/maintainers.md](./docs/maintainers.md) for the full runbook.

## Adding support for a new framework

The most valuable contribution! Open a [scaffold request](https://github.com/bloxy-studios/groot/issues/new?template=scaffold_request.yml) first so we can agree on the generator and flags, then read [docs/architecture.md](./docs/architecture.md) (adapter contract) and [docs/scaffold-flows.md](./docs/scaffold-flows.md) (the documentation format every adapter needs).

## Questions?

Open a [Discussion](https://github.com/bloxy-studios/groot/discussions) — issues are reserved for actionable bugs and features.
