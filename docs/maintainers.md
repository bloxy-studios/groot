# Maintainer runbook

Operational guide for groot maintainers. Contributors don't need this; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## One-time repository setup

Most settings are automated — run once with the [GitHub CLI](https://cli.github.com/) authenticated as the repo admin:

```sh
./scripts/setup-repo.sh
```

It configures: repo description/topics, merge hygiene (squash-only, delete branches, auto-merge), labels, Actions default token permissions (read-only), Dependabot alerts, secret scanning + push protection, private vulnerability reporting, and the `main` branch ruleset (PRs only, required status checks, no force pushes).

**UI-only toggles** (GitHub has no API for these — do them once by hand):

1. **Settings → General → Features**: enable *Discussions* (the setup script attempts this too) and create a **Q&A** category.
2. **Settings → Moderation options → Reported content**: enable *"Accept content reports from collaborators and prior contributors"* — the last item on the Community Standards checklist.
3. **Insights → Community Standards**: verify everything is green.

## npm: claiming and securing `create-groot`

Do this **early** — unclaimed names can be squatted.

> **The Bun-only exception.** groot's Bun-only rule governs *development* workflows. npm **registry administration** — the one-time first publish and token management below — legitimately uses the npm CLI, because it is the registry's own tooling (2FA login sessions, trusted-publisher bootstrap). Day-to-day publishing never happens on a laptop: CI runs `changeset publish` via the release workflow.

1. **Bootstrap auth (configured).** A granular `NPM_TOKEN` (write access; 90-day max lifetime — classic tokens no longer exist) lives in this repo's **Actions secrets**. The release workflow publishes with it, and provenance stays enabled via `NPM_CONFIG_PROVENANCE`. Granular tokens expire — note the rotation date.
2. **Upgrade to Trusted Publishing (OIDC)** once the package exists on npm, at npmjs.com → `create-groot` → Settings → Trusted Publisher → GitHub Actions:
   - Organization or user: `bloxy-studios`
   - Repository: `groot`
   - Workflow filename: `release.yml`
   - Environment: *(leave empty)*
   After verifying one OIDC publish, **delete the `NPM_TOKEN` secret** — the workflow needs no changes (npm auto-detects the OIDC environment), and provenance remains automatic.
3. **Manual publish (disaster recovery only):** `cd packages/cli && npm login && npm publish --access public` — covered by the Bun-only exception above.

## Release flow (fully automated after setup)

1. PRs with changesets merge into `main`.
2. The **Release** workflow maintains a `chore: version packages` PR (changelog + version bumps).
3. Merging that PR triggers: `changeset publish` → npm publish (provenance) → git tag `create-groot@X.Y.Z` → GitHub Release → the `binaries` job compiles `groot` for linux-x64/arm64, darwin-x64/arm64, windows-x64, generates `SHA256SUMS.txt`, and uploads everything to the release.
4. Verify: release page shows 6 assets (5 binaries + checksums); `bun info create-groot version` matches; run the installer end-to-end on one platform.

## Greptile review loop (policy)

- Every PR gets an automatic Greptile review on open **and a re-review on every push** (config: [`greptile.json`](../greptile.json), `triggerOnUpdates: true`).
- Want an extra pass without pushing? Comment `@greptileai` on the PR.
- Merge bar: **5/5 confidence score**. Override only with a written justification comment; overrides should be rare and boring.

## Security response

Reports arrive via [private vulnerability reporting](https://github.com/bloxy-studios/groot/security/advisories/new). Per [SECURITY.md](../SECURITY.md): acknowledge ≤ 48h, assess ≤ 7 days, coordinate disclosure ≤ 90 days. Develop fixes in a temporary private fork (GitHub advisory workflow), publish the advisory with credit, ship via the normal release flow.

## Ongoing hygiene

- **Dependabot PRs** (weekly, grouped): review + merge; majors land as separate PRs — read changelogs before merging.
- **Scorecard**: check the badge/dashboard after the weekly run; regressions usually mean an unpinned action or permissions drift.
- **Generator drift**: when an upstream generator changes flags/output (create-next-app, sv, create-expo-app, create-hono, convex), update the adapter and [scaffold-flows.md](./scaffold-flows.md) (facts + sources + verification date) in the same PR.
- **Badges**: after the first Scorecard run, add the OpenSSF badge to README; after first npm publish, add the npm version badge. Optional: register at [bestpractices.dev](https://www.bestpractices.dev/) for the CII badge.
- **Contacts**: CODE_OF_CONDUCT.md and SECURITY.md currently route reports through GitHub — when a dedicated project email exists, update both files.
