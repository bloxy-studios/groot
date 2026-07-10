#!/usr/bin/env bash
# One-time repository configuration for bloxy-studios/groot.
#
# Run by a repository admin with the GitHub CLI authenticated (`gh auth login`):
#   ./scripts/setup-repo.sh
#
# Idempotent: safe to re-run. Configures metadata, merge hygiene, labels, Actions
# token permissions, security features, and the main branch ruleset.
#
# Run this AFTER the initial infrastructure PRs are merged — the ruleset requires
# the CI status checks defined in .github/workflows/ci.yml.

set -euo pipefail

REPO="${GROOT_REPO:-bloxy-studios/groot}"

command -v gh >/dev/null 2>&1 || { echo "error: GitHub CLI (gh) is required — https://cli.github.com" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }
gh auth status >/dev/null || { echo "error: run 'gh auth login' first" >&2; exit 1; }

echo "==> configuring ${REPO}"

echo "--> metadata (description, topics)"
gh repo edit "$REPO" \
  --description "🌱 Plant a bun-first Turborepo and grow it — web, mobile, API and Convex backend from one command." \
  --add-topic bun \
  --add-topic turborepo \
  --add-topic monorepo \
  --add-topic scaffolding \
  --add-topic cli \
  --add-topic nextjs \
  --add-topic sveltekit \
  --add-topic expo \
  --add-topic elysia \
  --add-topic hono \
  --add-topic convex \
  --add-topic typescript

echo "--> merge hygiene & features (squash-only, auto-delete branches, discussions)"
gh repo edit "$REPO" \
  --enable-squash-merge \
  --enable-merge-commit=false \
  --enable-rebase-merge=false \
  --delete-branch-on-merge \
  --enable-auto-merge \
  --enable-discussions \
  --enable-issues \
  --enable-wiki=false \
  --enable-projects=false

echo "--> labels"
label() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force; }
label "type: bug"              "d73a4a" "Something is broken"
label "type: feature"          "a2eeef" "New capability"
label "type: scaffold-request" "0e8a16" "Request to support a new framework or generator"
label "type: docs"             "0075ca" "Documentation"
label "type: ci"               "cfd3d7" "CI and workflows"
label "type: dependencies"     "ededed" "Dependency updates"
label "type: security"         "ee0701" "Security-related"
label "status: needs-triage"   "fbca04" "Awaiting maintainer triage"
label "status: blocked"        "b60205" "Blocked on something else"
label "good first issue"       "7057ff" "Good for newcomers"
label "help wanted"            "008672" "Maintainers would welcome a PR"

echo "--> Actions: default workflow token read-only (PR creation stays on for changesets)"
# can_approve_pull_request_reviews=true is REQUIRED: the release workflow's
# changesets action opens the "chore: version packages" PR with GITHUB_TOKEN,
# which GitHub blocks when this is false. Merge safety comes from the
# protect-main ruleset (required checks incl. Greptile), not from this toggle.
gh api -X PUT "repos/${REPO}/actions/permissions/workflow" \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true

echo "--> security features"
# Dependabot alerts
gh api -X PUT "repos/${REPO}/vulnerability-alerts" >/dev/null
# Private vulnerability reporting (SECURITY.md points here)
gh api -X PUT "repos/${REPO}/private-vulnerability-reporting" >/dev/null
# Secret scanning + push protection
gh api -X PATCH "repos/${REPO}" --input - >/dev/null <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
echo "    dependabot alerts, private vulnerability reporting, secret scanning + push protection: enabled"

echo "--> main branch ruleset"
existing="$(gh api "repos/${REPO}/rulesets" --jq '[.[] | select(.name == "protect-main")] | length')"
if [ "$existing" -gt 0 ]; then
  echo "    ruleset 'protect-main' already exists — leaving it untouched"
else
  # NOTE: required_approving_review_count is 0 because groot currently has a single
  # maintainer (you can't approve your own PR). Raise it to 1+ as the team grows.
  # The status check contexts must match the job names in .github/workflows/ci.yml.
  gh api -X POST "repos/${REPO}/rulesets" --input - >/dev/null <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": true,
        "required_status_checks": [
          { "context": "Lint, typecheck & test" },
          { "context": "Compile smoke test" }
        ]
      }
    }
  ]
}
JSON
  echo "    ruleset 'protect-main' created (PRs only, squash merges, required checks, no force pushes)"
fi

cat <<'EOF'

==> done. Remaining manual steps (GitHub has no API for these):

  1. Settings → Moderation options → Reported content:
     enable "Accept content reports from collaborators and prior contributors".
  2. Discussions → create a "Q&A" category (SUPPORT.md links to it).
  3. npm (see docs/maintainers.md):
     - first manual publish of create-groot to claim the name,
     - then configure Trusted Publishing for release.yml (no token needed afterwards).
  4. After the first Scorecard run: add the OpenSSF badge to README.md.

EOF
