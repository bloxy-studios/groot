# groot CLI specification

> Status: **normative contract**. `init` shipped in v0.2; `add` and `doctor` shipped in v0.3; `init --preset` ships in v0.4. Changes to this document are semver-relevant.

## Invocation forms

| Form | Notes |
| --- | --- |
| `bun create groot [dir] [flags]` | bun resolves to the `create-groot` package; a leading bare destination (no subcommand) is routed to `init` |
| `bunx create-groot@latest init [dir] [flags]` | explicit |
| `groot init [dir] [flags]` | standalone compiled binary (curl/PowerShell install) |

The npm package requires Bun ≥ 1.2 on the invoking machine. The compiled binary embeds its own runtime, but scaffolded workspaces still require Bun — `groot` checks and reports this in preflight.

## `groot init [dir]`

Plant a new workspace. Interactive by default; fully scriptable with flags.

### Flags

| Flag | Values | Default | Notes |
| --- | --- | --- | --- |
| `--name <name>` | string | dir basename | Workspace/root package name |
| `--web <choice>` | `next` \| `sveltekit` \| `none` | prompt | Web app in `apps/web` |
| `--mobile <choice>` | `expo` \| `none` | prompt | Mobile app in `apps/mobile` |
| `--api <choice>` | `elysia` \| `hono` \| `none` | prompt | API app in `apps/api` |
| `--backend <choice>` | `convex` \| `none` | prompt | Backend in `packages/backend` |
| `--preset <path>` | groot.json file or workspace dir | — | Selections source for slots not fixed by flags — see [Presets](#presets) |
| `--yes`, `-y` | — | off | Accept defaults for all unanswered prompts |
| `--dry-run` | — | off | Print the resolved plan; write nothing |
| `--json` | — | off | With `--dry-run`: machine-readable plan on stdout |
| `--no-install` | — | install on | Skip root `bun install` |
| `--no-git` | — | git on | Skip `git init` + initial commit |
| `--dir-conflict <policy>` | `error` \| `merge` \| `increment` | `error` | Non-empty target directory policy |
| `--keep-failed` | — | off | Don't delete the target dir if a generator fails |
| `--verbose` | — | off | Stream generator output instead of spinners |
| `--version`, `-v` / `--help`, `-h` | — | — | Standard |

### Defaults (`--yes` with no selection flags)

`--web next --mobile none --api none --backend convex` — a Next.js app wired to a Convex backend: groot's flagship pairing.

### Presets

`--preset <path>` reads an existing `groot.json` — a file, or a workspace directory containing one — as the **selections source**: `groot init my-app --preset ../flagship` replicates the shape of the workspace that manifest describes.

- Only the slot → framework shape is read. Workspace name, destination paths, ports, generator pins, `conventions`, and `createdWith` always come from the current CLI — a preset written by an older groot never pins stale generators.
- Explicit slot flags win over the preset; slots absent from the preset resolve to `none`. With a target directory given, a preset run is fully non-interactive.
- The preset is validated like any workspace manifest — unknown framework ids or manifest versions are rejected with exit 2.
- A manifest that grew multiple scaffolds into one slot (via `groot add --path`) presets the **first** one per slot and warns about the rest — replicate them with `groot add --path` afterwards.

### Interactive flow

Prompts (clack) run **only for slots not already fixed by flags** — mixing flags and prompts is supported. Prompt order: web → mobile → api → backend → confirm plan. Ctrl-C at any prompt exits with code 130 and writes nothing.

### Output contract

- Human mode: staged progress (plant → grow per app → stitch → verify) with a final "next steps" block (e.g. the deferred `bunx convex dev` login step when Convex is selected).
- `--dry-run --json` emits the plan (schema below) and exits 0. Nothing else is written to stdout in `--json` mode; diagnostics go to stderr.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected internal error |
| 2 | Invalid flags/arguments |
| 3 | Preflight failure (bun missing, dir conflict under `error` policy, offline) |
| 4 | Generator failure (upstream create-* command failed) |
| 5 | Stitch/verify failure |
| 130 | Cancelled at a prompt |

## `groot add <scaffold>` (v0.3)

Grow an existing groot workspace: `groot add expo`, `groot add hono`, `groot add sveltekit --path apps/marketing`.

Runs the same grow → stitch → verify stages as `init` for just the new scaffold — no trunk is re-planted. Because every stitch operation is idempotent over the existing scaffolds, cross-cutting wiring lands automatically: adding `convex` links the existing web/mobile apps to the backend, and adding a frontend next to an existing backend wires the new app the same way. The stitch stage persists the updated `groot.json`.

### Flags

| Flag | Values | Default | Notes |
| --- | --- | --- | --- |
| `<scaffold>` | `next` \| `sveltekit` \| `expo` \| `elysia` \| `hono` \| `convex` | required | Positional: the scaffold to grow |
| `--path <dir>` | workspace-relative | the framework's slot path | Fresh directory (absent or empty), a direct child of `apps/` (web/mobile/api) or `packages/` (backend), not claimed by `groot.json` |
| `--no-install` | — | install on | Skip the root `bun install` after growing |
| `--keep-failed` | — | off | Keep the new scaffold directory if its generator fails |
| `--dry-run` | — | off | Print the would-be scaffold and the `groot.json` change; write nothing |
| `--verbose` | — | off | Stream generator output instead of progress lines |

### Rules

- Requires a `groot.json` manifest (written by `init`) — `add` walks up from the current directory to find the workspace root. Relative `--path` values resolve against that root, not the current directory.
- **Occupancy**: a scaffold whose slot is already filled is refused (exit 2) unless `--path` targets a fresh directory. Path equality with any existing scaffold is always refused. The backend slot is single-occupancy — its package name (`@repo/backend`) is fixed by the workspace conventions, so `--path` is no escape hatch there.
- **Ports**: a dev-port collision with an existing scaffold (e.g. growing Hono next to Elysia — both default to 3001) is a **warning**, not an error; `groot doctor` flags it persistently until one port is changed.
- **Provenance**: `groot.json`'s `createdWith` keeps its original value — it records which CLI planted the workspace, not which one last grew it.
- **Git**: `add` never runs `git init` — the workspace keeps whatever git state it has, including none.
- **Targeted rollback**: if the generator fails, only the new scaffold directory is removed (`--keep-failed` keeps it for inspection); the rest of the workspace is never touched. Stitch/verify failures leave the tree in place, as in `init`.

### Exit codes

Same table as `init`: `2` invalid arguments and occupancy violations, `4` generator failure, `5` stitch/verify failure.

## `groot doctor` (v0.3)

Verify workspace health: workspace globs valid, single lockfile, no port collisions, per-scaffold checks from each adapter (e.g. `convex/_generated` in sync), bun version, turbo tasks resolvable. Exits 0 (healthy) or 5 (problems found, each with a suggested fix). `--json` emits structured results.

## `groot.json` manifest

Written to the workspace root by `init`, updated by `add`. The manifest is groot's memory — never required by the apps themselves at runtime.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/bloxy-studios/groot/main/schemas/groot.schema.json",
  "version": 1,                      // manifest schema version
  "createdWith": "create-groot@0.2.0",
  "conventions": {
    "packagesNamespace": "@repo"
  },
  "scaffolds": [
    {
      "slot": "web",
      "framework": "next",
      "path": "apps/web",
      "generator": "create-next-app@16",   // pinned major actually used
      "port": 3000
    },
    {
      "slot": "backend",
      "framework": "convex",
      "path": "packages/backend",
      "generator": null,                   // groot wrote these files directly
      "port": null
    }
  ]
}
```

## Non-interactive contract (CI & agents)

groot treats scriptability as a first-class feature:

1. Any run where **every slot is fixed by flags (or a `--preset`) and `--yes` is present** must complete with zero prompts, or exit non-zero — it must never hang waiting for input.
2. `--dry-run --json` is stable, versioned output (the manifest schema) — safe for agents to parse.
3. Non-TTY environments (CI) behave as if `--verbose` were set: no spinners, plain line-based progress.
4. Anything interactive that cannot be avoided (today: Convex login) is **never run by groot** — it is printed as a next step instead.
