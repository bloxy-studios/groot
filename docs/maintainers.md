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

Do this **early** — unclaimed names can be squatted:

1. **First publish (manual, one time).** npm's trusted publishing is configured on an *existing* package, so bootstrap with:
   ```sh
   cd packages/cli
   npm login            # 2FA session (npm's 2025+ auth model)
   npm publish --access public
   ```
   Publishing `0.0.x` of the skeleton is exactly what v0.1 is for.
2. **Configure Trusted Publishing (OIDC)** at npmjs.com → `create-groot` → Settings → Trusted Publisher → GitHub Actions:
   - Organization or user: `bloxy-studios`
   - Repository: `groot`
   - Workflow filename: `release.yml`
   - Environment: *(leave empty)*
   After this, CI publishes **without any npm token**, and provenance is automatic.
3. **Fallback only if OIDC is unavailable**: create a *granular* access token (write, 90-day max — classic tokens no longer exist), save as the `NPM_TOKEN` repository secret, and note the rotation date. Prefer OIDC; delete the token once OIDC works.

## Release flow (fully automated after setup)

1. PRs with changesets merge into `main`.
2. The **Release** workflow maintains a `chore: version packages` PR (changelog + version bumps).
3. Merging that PR triggers: `changeset publish` → npm publish (provenance) → git tag `create-groot@X.Y.Z` → GitHub Release → the `binaries` job compiles `groot` for linux-x64/arm64, darwin-x64/arm64, windows-x64, generates `SHA256SUMS.txt`, and uploads everything to the release.
4. Verify: release page shows 6 assets (5 binaries + checksums); `npm view create-groot version` matches; run the installer end-to-end on one platform.

## Greptile review loop (policy)

- Every PR gets an automatic Greptile review on open (config: [`greptile.json`](../greptile.json)).
- Greptile does **not** re-review on push — after fixes, comment `@greptileai` on the PR.
- Merge bar: **5/5 confidence score**. Override only with a written justification comment; overrides should be rare and boring.

## Security response

Reports arrive via [private vulnerability reporting](https://github.com/bloxy-studios/groot/security/advisories/new). Per [SECURITY.md](../SECURITY.md): acknowledge ≤ 48h, assess ≤ 7 days, coordinate disclosure ≤ 90 days. Develop fixes in a temporary private fork (GitHub advisory workflow), publish the advisory with credit, ship via the normal release flow.

## Ongoing hygiene

- **Dependabot PRs** (weekly, grouped): review + merge; majors land as separate PRs — read changelogs before merging.
- **Scorecard**: check the badge/dashboard after the weekly run; regressions usually mean an unpinned action or permissions drift.
- **Generator drift**: when an upstream generator changes flags/output (create-next-app, sv, create-expo-app, create-hono, convex), update the adapter and [scaffold-flows.md](./scaffold-flows.md) (facts + sources + verification date) in the same PR.
- **Badges**: after the first Scorecard run, add the OpenSSF badge to README; after first npm publish, add the npm version badge. Optional: register at [bestpractices.dev](https://www.bestpractices.dev/) for the CII badge.
- **Contacts**: CODE_OF_CONDUCT.md and SECURITY.md currently route reports through GitHub — when a dedicated project email exists, update both files.
