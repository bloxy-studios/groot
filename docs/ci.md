# Scaffolding in CI & from agents

> Status: **guide** — recipes and patterns. The normative contract (flags, exit codes, schemas, the non-interactive rules) lives in [cli-spec.md](./cli-spec.md); when this page and the spec disagree, the spec wins.

groot treats scriptability as a first-class feature: every command has a fully non-interactive mode, machine-readable output, and spec'd exit codes. This page shows the patterns that fall out of that.

## The guarantees you're building on

From the [non-interactive contract](./cli-spec.md#non-interactive-contract-ci--agents):

1. **No hidden prompts.** A run where every slot is decided — by flags, a `--preset`, or `--yes` defaults — completes with zero prompts or exits non-zero. Without a TTY, groot refuses to prompt (exit 2, with a hint) rather than hang your job.
2. **Pure machine output.** `init --dry-run --json` and `add --dry-run --json` emit the versioned [`groot.json` manifest schema](./cli-spec.md#grootjson-manifest) on stdout; `doctor --json` emits structured check results. Diagnostics always go to stderr.
3. **Plain progress.** Output is line-based everywhere — there are no spinners to garble CI logs. Pass `--verbose` to also stream full generator output into the log.
4. **Deferred interactivity.** Anything that cannot be non-interactive (today: the Convex login) is never run by groot — it's printed as a next step.

groot also exports `CI=1` to every generator it runs, so upstream `create-*` tools stay non-interactive too.

## Scaffold a workspace in GitHub Actions

```yaml
jobs:
  scaffold:
    runs-on: ubuntu-latest
    steps:
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: latest

      # Plant a workspace non-interactively. Exit codes are the contract:
      # 0 ok · 2 usage · 3 preflight · 4 generator · 5 stitch/verify.
      - name: Plant workspace
        run: bunx create-groot@latest init acme --web next --api elysia --backend convex --yes --no-git

      # The workspace is bun-native end to end.
      - name: Build it
        working-directory: acme
        run: bun run build
```

Notes:

- `--no-git` keeps the scaffold out of git inside an existing checkout; use `--no-install` too if you only need the tree.
- Generators download from the npm registry at scaffold time — the job needs registry egress.
- Pin your action SHAs (as above) per your own security policy; this repo's workflows do.

## Validate a plan before writing anything (agents)

`--dry-run --json` is the agent-safe way to see exactly what groot would do:

```sh
# What would this init produce?
bunx create-groot@latest init acme --preset shapes/team.json --dry-run --json | bun -e '
  const plan = await Bun.stdin.json();
  console.log(plan.scaffolds.map((s) => `${s.slot}:${s.framework}`).join(" "));
'
```

The output is the manifest exactly as `groot.json` would be written — stable, versioned (`version: 1`), and schema-published. The same shape comes back from `groot add --dry-run --json`, with the new scaffold as the final entry:

```sh
# Gate a grow operation on its plan.
groot add hono --path apps/gateway --dry-run --json > plan.json   # exit 2 = refused (occupancy/paths)
groot add hono --path apps/gateway                                 # actually grow
```

Port-collision warnings arrive on stderr and never contaminate the JSON.

## `groot doctor` as a health gate

`doctor` exits `0` (healthy — warnings allowed) or `5` (problems found, each with a suggested fix), so it drops straight into CI:

```yaml
      - name: Workspace health gate
        run: bunx create-groot@latest doctor --json > doctor.json
```

Parse `healthy`, or surface individual checks — every entry is `{ name, status: "pass" | "warn" | "fail", detail, fix? }`. Warnings (like a pending Convex first login) don't fail the gate; hard problems (nested lockfiles, port collisions, missing packages) do.

## Replicating a shape across repos

Commit a `groot.json` anywhere (or point at an existing workspace) and use it as a [preset](./cli-spec.md#presets):

```sh
bunx create-groot@latest init service-x --preset ./shapes/flagship.json --yes --no-git --no-install
```

Only the slot → framework shape is read from the preset — generator pins always come from the CLI version you're running, so presets never freeze upstream versions.
