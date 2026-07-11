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
   > **Nudge required:** GitHub intentionally does not run `pull_request` workflows on PRs created by a workflow's own `GITHUB_TOKEN`, so the version PR arrives with no CI checks. Close and reopen it (or push an empty commit to `changeset-release/main`) to fire the required checks, and comment `@greptileai` if the review didn't start automatically.
3. Merging that PR triggers: `changeset publish` → npm publish (provenance) → git tag `create-groot@X.Y.Z` → GitHub Release → the `binaries` job compiles `groot` for linux-x64/arm64, darwin-x64/arm64, windows-x64, generates `SHA256SUMS.txt`, and uploads everything to the release.
4. Verify: release page shows 6 assets (5 binaries + checksums); `bun info create-groot version` matches; run the installer end-to-end on one platform.

## Greptile review loop (policy)

- Every PR gets an automatic Greptile review on open **and a re-review on every push** (config: [`greptile.json`](../greptile.json), `triggerOnUpdates: true`).
- Want an extra pass without pushing? Comment `@greptileai` on the PR.
- Merge bar: **5/5 confidence score**. Override only with a written justification comment; overrides should be rare and boring.

## Upstream drift watch

Two scheduled jobs keep groot honest against its moving upstream targets:

- **Behavior drift — [`e2e.yml`](../.github/workflows/e2e.yml) (Wednesdays 05:41 UTC)** runs the real generators end to end. A red run means upstream output changed under an existing pin: fix the adapter and [scaffold-flows.md](./scaffold-flows.md) in the same PR.
- **Pin & doc drift — [`drift.yml`](../.github/workflows/drift.yml) (Mondays 06:13 UTC)** runs [`scripts/check-upstream-drift.ts`](../scripts/check-upstream-drift.ts): every pinned series (trunk + matrix generators, the Expo SDK template tag, the dependency ranges in groot-authored packages — all read from the modules the CLI executes) is compared against the registry's latest, and scaffold-flows.md's "Last verified" date is held to a 90-day budget. Findings upsert a single [`upstream-drift`-labeled issue](https://github.com/bloxy-studios/groot/issues?q=label%3Aupstream-drift) — updated in place via a body fingerprint, closed automatically when drift clears. Registry failures fail the run instead of filing misleading issues.

Intentional pin lags (e.g. scaffolded packages staying on TypeScript 5 while this repo builds with 7) live in the script's allowlist, each with a written reason; they're reported in the issue's collapsed "allowlisted" section rather than as findings. When the drift issue opens: re-verify the named section against upstream, bump the pin in its adapter, refresh scaffold-flows.md (facts, sources, date), and land it all in one PR.

## Security response

Reports arrive via [private vulnerability reporting](https://github.com/bloxy-studios/groot/security/advisories/new). Per [SECURITY.md](../SECURITY.md): acknowledge ≤ 48h, assess ≤ 7 days, coordinate disclosure ≤ 90 days. Develop fixes in a temporary private fork (GitHub advisory workflow), publish the advisory with credit, ship via the normal release flow.

## Ongoing hygiene

- **Dependabot PRs** (weekly, grouped): review + merge; majors land as separate PRs — read changelogs before merging.
- **Scorecard**: check the badge/dashboard after the weekly run; regressions usually mean an unpinned action or permissions drift.
- **Generator drift**: when an upstream generator changes flags/output (create-next-app, sv, create-expo-app, create-hono, convex), update the adapter and [scaffold-flows.md](./scaffold-flows.md) (facts + sources + verification date) in the same PR.
- **Badges**: after the first Scorecard run, add the OpenSSF badge to README; after first npm publish, add the npm version badge. Optional: register at [bestpractices.dev](https://www.bestpractices.dev/) for the CII badge.
- **Contacts**: CODE_OF_CONDUCT.md and SECURITY.md currently route reports through GitHub — when a dedicated project email exists, update both files.
