# Security Policy

Thank you for helping keep groot and its users safe. We take every report seriously and appreciate responsible disclosure.

## Supported Versions

groot is pre-1.0 software. Security fixes are applied to the **latest published release only**.

| Version        | Supported |
| -------------- | --------- |
| Latest release | ✅        |
| Older releases | ❌        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, use GitHub's private vulnerability reporting:

1. Go to [**Report a vulnerability**](https://github.com/bloxy-studios/groot/security/advisories/new) (Security tab → *Report a vulnerability*).
2. Include as much of the following as you can:
   - A description of the issue and its impact.
   - Steps to reproduce, or a proof of concept.
   - The affected component (CLI package, installer scripts, release pipeline, generated workspace output).
   - Affected version(s) and platform(s).

### What to expect

| Stage                 | Target time            |
| --------------------- | ---------------------- |
| Acknowledgement       | Within 48 hours        |
| Initial assessment    | Within 7 days          |
| Fix or mitigation     | Depends on severity — critical issues are prioritized immediately |
| Coordinated disclosure | Within 90 days of the report, or sooner once a fix ships |

We will keep you informed throughout, credit you in the advisory (unless you prefer to stay anonymous), and publish a GitHub Security Advisory once a fix is available.

## Scope

In scope:

- The `create-groot` npm package and the `groot` compiled binaries.
- The `install.sh` / `install.ps1` installer scripts.
- The release pipeline (GitHub Actions workflows, checksums, provenance).
- Code that groot writes into scaffolded workspaces (the stitching layer itself).

Out of scope:

- Vulnerabilities in the third-party frameworks groot scaffolds (Next.js, SvelteKit, Expo, Elysia, Hono, Convex, Turborepo) — please report those upstream to the respective projects.
- Dependency vulnerabilities that already have public advisories (these are handled via Dependabot).
- Social engineering, physical attacks, or issues requiring a compromised developer machine.

## Supply-chain hardening in this repository

- All GitHub Actions are pinned to full commit SHAs.
- Workflows run with least-privilege `GITHUB_TOKEN` permissions.
- npm releases are published from CI with provenance.
- Release binaries ship with a `SHA256SUMS.txt` that the installers verify before installing.

## No bug bounty

groot is a community open-source project and does not currently offer a paid bug bounty. We deeply appreciate reports all the same, and we credit reporters in advisories and release notes.
