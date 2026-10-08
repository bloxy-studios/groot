# Stability contract

> Status: **binding as of v1.0.0.** This document is the semver contract — breaking any covered item requires a major release. **Groot v2** is that major: its deliberate changes are listed under [Version 2](#version-2-deliberate-changes); v2-only surfaces become covered when 2.0.0 leaves the `next` prerelease channel.

groot's promise is narrow on purpose: the **interface** is stable; the **output workspaces** track living upstream generators by design. This page defines exactly where that line sits.

## Covered by semver

| Surface | Where it's specified |
| --- | --- |
| The command set: `init`, `add`, `doctor` — plus the bun-create bare-destination routing (`bun create groot my-app` → `init`) | [cli-spec.md](./cli-spec.md) |
| Every documented flag: name, value domain, default, and semantics (including aliases like `-y`) | cli-spec flag tables |
| Exit codes: `0` ok · `1` internal · `2` usage · `3` preflight · `4` generator · `5` stitch/verify/doctor-problems · `130` cancelled | [cli-spec.md#exit-codes](./cli-spec.md#exit-codes) |
| The `groot.json` schema — `version: 1` (frozen: [groot.v1.schema.json](../schemas/groot.v1.schema.json)) and `version: 2` (the blueprint) — and its published `$schema` URL, which accepts both | [schemas/groot.schema.json](../schemas/groot.schema.json) |
| `--json` output shapes: `init`/`add` dry runs emit the manifest schema on pure stdout; `doctor --json` emits `{ healthy, workspaceRoot, checks[] }` with `checks[]` entries shaped `{ name, status: pass\|warn\|fail, detail, fix? }` | cli-spec output contracts |
| The non-interactive contract (never prompt without a TTY; stdout purity in `--json`; plain line-based progress; interactive steps deferred, never run) | [cli-spec.md#non-interactive-contract-ci--agents](./cli-spec.md#non-interactive-contract-ci--agents) |
| Bin names `groot` and `create-groot`; `install.sh` / `install.ps1` entry points and their checksum-verification behavior | package.json `bin`, installers |

## Explicitly NOT covered

- **Human-readable output**: progress lines, summaries, banners, colors, emoji, and the *wording* of error messages and hints. Only exit codes and documented stderr/stdout routing are contractual — never the text. Parse `--json`, not prose.
- **Scaffolded workspace content**: groot orchestrates official generators live, so scaffold output changes whenever upstream ships — that is the product's core bet, not a break. The stitched *invariants* (workspace globs, one lockfile, `@repo/*` links, non-conflicting documented ports, a valid manifest) are covered via `doctor`'s healthy semantics; the exact files are not.
- **Generator pins**: bumping a pinned series (e.g. `create-next-app@16` → `@17`) is a **minor** groot release, changelogged and re-verified in [scaffold-flows.md](./scaffold-flows.md). Pin bumps change scaffold output, not the CLI surface.
- **Doctor check names and detail strings**: the check *set* may grow or be renamed in minors; `healthy` semantics, exit codes, and the `--json` field shape are the contract.
- **Prompt UX**: interactive flows may be reworded or reordered. What's contractual is that they never appear without a TTY and never block a fully-specified run.

## Change rules

- Breaking any covered item → **major**.
- Additive changes (new commands, new flags, new optional manifest fields, new doctor checks) → **minor**.
- Generator pin bumps → **minor** (see above).
- **Deprecation path**: a covered flag or command is marked deprecated in docs and warns on use for **at least one minor release** before removal in the next major.

### Manifest schema evolution

- Additive **optional** fields keep `version: 1` and are minors; validators must ignore unknown optional fields they don't understand — but note the schema currently sets `additionalProperties: false`, so additive fields land in the schema file in the same PR.
- Any breaking shape change bumps the manifest `version` to `2`; `add` and `doctor` must read **both** versions for at least one major, and `init` writes the newest.
- The `$schema` URL never changes meaning: it always describes the newest version, with prior versions documented in this repo's history.

## Enforcement

[`packages/cli/src/contract.test.ts`](../packages/cli/src/contract.test.ts) snapshots the covered surface — the flag set of every command, aliases, exit codes, the bun-create routing table, and the schema's invariants (version const, required fields, slot/framework enums cross-checked against the live scaffold matrix). Any PR that touches the surface fails CI until the snapshot is updated **in the same PR**, which is the reviewer's cue to check this contract's change rules before merging.

## Version 2 (deliberate changes)

v2 keeps the v1 command set, flags, exit codes, and stdout/stderr routing. These changes are deliberate and only ship in a major release:

| Change | Before (v1) | After (v2) | Rollback limit |
| --- | --- | --- | --- |
| `groot.json` written by `init` | `version: 1` manifest | `version: 2` blueprint — a strict superset (`createdWith`, `conventions`, `scaffolds` keep their v1 meaning) | v1 CLIs reject version 2 files; pin `create-groot@1` to keep writing v1 |
| `init --dry-run --json` and `add --dry-run --json` on fresh/v2 workspaces | v1 manifest | v2 blueprint | consumers of the v1 fields keep working; `version` checks must accept 2 |
| `groot.json` reading (`add`, `doctor`, `--preset`) | version 1 only | versions 1 and 2; `add` writes back the version it found | — |
| `groot add` dev-port collision in a **v2** workspace | warning; the new scaffold keeps the colliding default port | the new scaffold gets the next free port, applied to its `dev` script or source and recorded in `groot.json` (v1 workspaces and Metro/Tauri keep the warning — [architecture.md#port-allocation](./architecture.md#port-allocation)) | change the port back by hand; `groot doctor` then flags the collision as in v1 |
| Reserved bare words for `bun create groot <word>` | `init`, `add`, `doctor` | also the v2 command names (see [v2-cli-spec.md](./v2-cli-spec.md#bare-word-routing)) | use `groot init <dir>` for such directory names |
| Compiled binaries | load `.env`/`bunfig.toml` from the working directory | never do (security fix); child process trees are swept on exit | — |
| `init --name ""` (empty or blank) | dry runs exited 0; real runs crashed after generating | usage error up front (exit 2) | pass a non-empty name |

Additive in v2 (minor-compatible): `init --topology single`, new doctor checks (`workspace layout`, `blueprint apps`), and the v2 commands.

Newly covered once 2.0.0 is stable (normative in [v2-cli-spec.md](./v2-cli-spec.md)):

- The v2 command set and documented flags (`inspect`, `adopt`, `migrate`, `plan`, `apply`, `verify`, `evidence`, `status`, `resume`, `rollback`, `context`, `task`, `review`, `mcp`, `schema`).
- Exit codes `6` conflict · `7` blocked · `8` locked for v2 surfaces (v1 codes keep their meanings).
- Stable error identifiers (`GROOT_E_*`) — renaming or removing one is breaking; adding one is a minor.
- The result envelope and every contract under [`schemas/v2/`](../schemas/v2/index.json) (additive optional fields are minors; documents carry `schemaVersion`).
- MCP tool names, their input schemas, and the `summary`/`next` result convention.
- `groot.lock.json` (`lockVersion: 1`) and the `.groot/` self-ignoring layout's existence (its internal file formats are not covered — use the commands and schemas).

Not covered in v2: recipe-generated file contents (recipes are versioned and certified separately), evidence `summary`/`details` wording, managed-region text, MCP tool descriptions and instructions text.
