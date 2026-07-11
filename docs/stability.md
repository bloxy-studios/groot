# Stability contract

> Status: **defined ahead of v1.0; becomes binding at v1.0.0.** Until then, minor releases may still adjust the surface below (each adjustment changelogged). From v1.0.0 on, this document is the semver contract — breaking any covered item requires a major release.

groot's promise is narrow on purpose: the **interface** is stable; the **output workspaces** track living upstream generators by design. This page defines exactly where that line sits.

## Covered by semver

| Surface | Where it's specified |
| --- | --- |
| The command set: `init`, `add`, `doctor` — plus the bun-create bare-destination routing (`bun create groot my-app` → `init`) | [cli-spec.md](./cli-spec.md) |
| Every documented flag: name, value domain, default, and semantics (including aliases like `-y`) | cli-spec flag tables |
| Exit codes: `0` ok · `1` internal · `2` usage · `3` preflight · `4` generator · `5` stitch/verify/doctor-problems · `130` cancelled | [cli-spec.md#exit-codes](./cli-spec.md#exit-codes) |
| The `groot.json` manifest schema (`version: 1`) and its published `$schema` URL | [schemas/groot.schema.json](../schemas/groot.schema.json) |
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
