# create-groot

🌱 **Plant a bun-first [Turborepo](https://turborepo.com) and grow it** — web (Next.js / SvelteKit), mobile (Expo), API (Elysia / Hono), and a Convex backend, scaffolded from official generators and stitched into one coherent bun workspace.

```sh
bun create groot my-app
```

> 🏛️ **v1.0 — stable.** `groot init` plants a complete workspace (web · mobile · API · backend), `groot add` grows another scaffold into an existing one, and `groot doctor` keeps it healthy. The CLI surface — flags, exit codes, the `groot.json` schema — is under a binding [semver contract](https://github.com/bloxy-studios/groot/blob/main/docs/stability.md). Full contract in the [CLI spec](https://github.com/bloxy-studios/groot/blob/main/docs/cli-spec.md); browse everything on the [docs site](https://bloxy-studios.github.io/groot/).

Prefer a standalone binary (no Bun needed to run the CLI)?

```sh
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/bloxy-studios/groot/main/install.sh | bash

# Windows (PowerShell)
powershell -c "irm https://raw.githubusercontent.com/bloxy-studios/groot/main/install.ps1 | iex"
```

Full documentation, contribution guide, and security policy live in the [groot repository](https://github.com/bloxy-studios/groot).

MIT © Bloxy Studios
