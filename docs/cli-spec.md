# groot CLI specification

> Status: **normative contract**. `init` shipped in v0.2; `add` and `doctor` land in v0.3 (stubs point here until then). Changes to this document are semver-relevant.

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

- Requires a `groot.json` manifest at the workspace root (written by `init`).
- Refuses to add a scaffold whose slot is already occupied unless `--path` targets a new directory.
- Runs the same generate → stitch → verify stages for just the new scaffold, then updates `groot.json`.

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

1. Any run where **every slot is fixed by flags and `--yes` is present** must complete with zero prompts, or exit non-zero — it must never hang waiting for input.
2. `--dry-run --json` is stable, versioned output (the manifest schema) — safe for agents to parse.
3. Non-TTY environments (CI) behave as if `--verbose` were set: no spinners, plain line-based progress.
4. Anything interactive that cannot be avoided (today: Convex login) is **never run by groot** — it is printed as a next step instead.
