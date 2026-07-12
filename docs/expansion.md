# Expansion plan

> Status: **exploratory — not normative.** This is the research ledger behind the [roadmap](./roadmap.md)'s post-1.0 themes: candidate scaffolds for every slot, two proposed new slots, a new add-on concept, git/GitHub powers, and agent-era capabilities. Facts were researched from official docs (linked) in July 2026 and are marked *unconfirmed* where a primary source didn't settle them. Nothing here is a commitment: a candidate graduates by having its flags **verified in [scaffold-flows.md](./scaffold-flows.md) in the same PR that ships its adapter**, per the normative-docs rule.

## How a candidate becomes a scaffold

Every adapter groot ships must satisfy the same bar the current six do:

1. **Official generator, or deliberately direct-write.** groot wraps each framework's own generator (`create-next-app`, `sv`, …) so scaffolds never rot behind upstream. When the official generator is unsuitable (none exists, it can't be silenced, or output diverges from the framework's own docs), groot writes a minimal file set directly — the Elysia and Convex precedent. Direct-write is only honest when the template is tiny and stable.
2. **Fully non-interactive.** Every prompt must have a flag (or positional). No TTY tricks, no `yes |` piping. If a generator can't be silenced, it isn't ready.
3. **TypeScript output.** TS-first templates, or an explicit TS flag.
4. **Bun-workspace safe.** Output lives under `apps/*` or `packages/*`, installs with the root `bun install`, writes no competing lockfile, and any postinstall behavior works under bun's lifecycle rules.
5. **Deterministic ports.** A documented default dev port groot can keep or remap (the allocator's pain point: defaults cluster on 3000 and 5173).
6. **Maintained + demanded.** Active upstream releases and a real audience. Tier C below usually means one of these failed.
7. **The full adapter kit.** Verified flags in scaffold-flows.md, stitch patches, doctor checks, E2E coverage, and a changeset — in one PR.

Tiers used throughout: **A** = adapter-ready and worth building, **B** = viable with named caveats, **C** = poor fit or premature today.

## The slot model grows

Today's matrix: web (`apps/web`), mobile (`apps/mobile`), api (`apps/api`), backend (`packages/backend`). The research argues for two structural additions:

- **A desktop slot (`apps/desktop`)** — both A-tier candidates scaffold cleanly and non-interactively; Tauri even ships an official `--ci` mode for wrapping the *existing* web app, which fits groot's stitch model perfectly.
- **An add-on concept** — a second composition primitive. The highest-demand backend-adjacent candidates (Drizzle, Better Auth, tRPC) all lack standalone official generators *by design*: they patch existing apps. Modeling them as slot occupants would be a lie; modeling them as **add-ons** (composable patch sets applied to existing scaffolds, recorded in the manifest) matches reality. Design tracked in the v1.4 milestone.

## Web slot candidates

| Candidate | Tier | Generator (researched) | Port | Verdict |
| --- | --- | --- | --- | --- |
| TanStack Start | A | `@tanstack/cli` 0.69.x (`tanstack create`) | 3000 | Start is 1.0 (2026-03); flags incl. `--package-manager bun`, `--no-git`, `--no-install`, `-y`; highest-demand new adapter |
| React Router (framework mode) | A | `create-react-router@8` | 5173 | The Remix successor at v8; `--yes --no-install --no-git-init` confirmed in source; c3-proven in CI |
| Nuxt | A | `create-nuxt` 3.36.x | 3000 | Every prompt has a flag (`--packageManager bun --no-install --no-gitInit --no-modules`); the Vue slot |
| Astro | A | `create-astro` 5.2.x | 4321 | Complete flag set (`--yes --no-install --no-git --no-ai`); TS-strict default; unique port |
| Vite templates | A | `create-vite` 9.x | 5173 | `--template react-ts --no-interactive`; zero side effects — the no-framework SPA option |
| Angular | B | `@angular/cli` 22.x (`ng new`) | 4200 | Promptless via `--defaults --skip-install --skip-git`, but nested `angular.json` workspace-in-workspace; bun PM enum unconfirmed |
| SolidStart | B | `create-solid` 0.7.x | 3000 | Official CLI exists but no confirmed flag to suppress the template prompt — needs a probe first; TanStack Start's `--framework Solid` may be the better Solid path |
| Qwik | C | `create-qwik` 1.20.x | 5173 | CI-friendly command mode, but v2 stuck in beta and low demand |
| Analog | C | `create-analog` 2.3.x | 5173 | Unconditional nested `git init` in the generator source; niche vs Angular itself |
| Waku | C | `create-waku` (1.0 alphas) | 3000 (unconfirmed) | Clean flags but pre-1.0 churn; revisit at 1.0 stable |

Notes: Remix 3 is in beta with no stable scaffolder — watchlist, not a candidate. Port reality: defaults cluster on 3000 (Next, TanStack, Nuxt, SolidStart) and 5173 (SvelteKit, RR, Vite, Qwik) — multi-web workspaces (`groot add sveltekit --path apps/marketing`) make the port allocator's determinism a real feature.

## Mobile slot candidates

| Candidate | Tier | Generator (researched) | Native toolchain | Verdict |
| --- | --- | --- | --- | --- |
| React Native (bare) | A | `@react-native-community/cli` 20.x (`init`) | Xcode + CocoaPods, Android SDK (build-time) | Flag-complete incl. `--pm bun --skip-install --skip-git-init`; needs a metro monorepo stitch patch and a port shift off 8081 when Expo coexists |
| Capacitor (+ Ionic) | B | `@capacitor/create-app` 0.5.x or `@ionic/cli` 7 (`--no-deps --no-git --no-interactive`) | Only for `cap add` / builds | Non-interactive and bun-clean, but the minimal template is vanilla JS; strongest as a wrap-apps/web add-on, like Tauri |
| Lynx (ByteDance) | B | `create-rspeedy` 0.15.x (`--dir --template react-ts`) | None to dev (Lynx Explorer) | Cleanest CLI of the group, bun-native; but shipping a store app needs native embedding with no official generator — young ecosystem |
| NativeScript | C | `nativescript` 9.x (`ns create`) | Xcode, Android SDK | Generator self-installs deps via npm with no documented skip flag (unconfirmed); niche demand |
| Flutter | out | Dart SDK binary | Flutter SDK | Dart project — not a bun workspace citizen |

## Desktop slot candidates (new slot)

| Candidate | Tier | Generator (researched) | Port | Verdict |
| --- | --- | --- | --- | --- |
| Tauri v2 | A | `create-tauri-app` 4.6.x (`--template react-ts --manager bun -y`) | 1420 (strictPort) | First-class bun support, no installs/git; plus an official wrap-existing mode: `@tauri-apps/cli init --ci` pointed at apps/web — two adapter shapes, both stitch-friendly. Rust needed only at dev/build time |
| Electron | A | `@quick-start/create-electron` 1.0.x (`--template react-ts --skip`) | 5173 | Fully silent (source-verified); TS template; the electron-vite standard. Caveats: community-maintained generator; electron's postinstall binary download must be trusted under bun |
| Electron (Forge) | B | `create-electron-app` 7.11.x | — | Org-official but force-installs deps (npm/yarn only) and its Vite template is flagged experimental — worse fit than electron-vite |
| Neutralinojs | C | `@neutralinojs/neu` 11.7.x | random (unconfirmed) | No TS template, GitHub-release binary downloads, non-npm project shape |
| Wails | C (out) | Go binary | — | Go module root; generator not on npm |

Slot design implication: Tauri's wrap-mode and Capacitor's wrap-mode suggest desktop/mobile shells around `apps/web` may eventually be **add-ons** rather than slot occupants — the v1.4 design should decide where wrapping lives.

## API slot candidates

| Candidate | Tier | Shape | Generator or direct | Verdict |
| --- | --- | --- | --- | --- |
| Fastify | A | slot | `fastify-cli` 8.x (`generate --lang=ts`) | Real official non-interactive generator, huge demand; groot patches the Node-centric dev script to `bun --watch` |
| Nitro | B | slot | v2 via giget template, or direct-write | Bun-native with a `bun` deploy preset, but v2→v3 (beta) package churn mid-2026 — direct-write v2 now or wait for v3 GA |
| GraphQL Yoga | B | slot | direct-write (one file on `Bun.serve`, port 4000) | Effortless and officially Bun-documented; niche demand for GraphQL scaffolds in 2026 |
| Express | B | slot | direct-write (express 5.x) | `express-generator` is dormant (CJS, no TS); evergreen name recognition justifies a tiny direct-write |
| NestJS | C | slot | `@nestjs/cli` 11.x | Open bun DI bug (double-instantiated factory providers), Node-spawning CLI, maintainers' explicit Node focus — wrong for a bun-only workspace today |

## Backend slot candidates

| Candidate | Tier | Shape | Generator or direct | Verdict |
| --- | --- | --- | --- | --- |
| Supabase | A | slot | `supabase` CLI 2.x (`init` is scriptable) | The highest-demand Convex alternative; Docker-bound `start` and login defer cleanly to next-steps output; real codegen (`gen types typescript`) |
| PocketBase | B | slot | direct-write + binary download script | Best zero-login local story after Convex; caveats: binary distributed outside npm, community-only typegen, 0.x churn |
| InstantDB | B | slot | direct-write schema/perms + `instant-cli` | Architecturally the truest Convex sibling (schema-in-repo, reactive, client-first); browser-login-gated app creation keeps it from A |
| Firebase | C | slot | none viable (`firebase init` is interactive + login-first) | Java-dependent emulators, Node-only functions runtime, everything login-gated |
| Appwrite | C | slot | none viable | Login-first CLI, Docker-compose self-host, tiny CLI adoption |

The C-tier pattern is consistent: **mandatory interactive login before any local artifact works**. groot's defer-to-next-steps design can't paper over a scaffold that is dead weight until a browser opens.

## Add-ons (new concept)

Add-ons patch existing scaffolds instead of owning a slot; the manifest records them; `doctor` checks them. All three A/B candidates below are direct-write by nature — none has (or needs) a standalone generator:

| Candidate | Tier | Patches | Setup | Verdict |
| --- | --- | --- | --- | --- |
| Drizzle ORM | A | api app (or a new `packages/db`) | direct-write config/schema/client + `drizzle-kit` codegen | `drizzle-orm/bun-sqlite` gives a zero-infra working database out of the box; `bun-sql` for Postgres; 1.0 RC imminent — pin decision at build time |
| Better Auth | A | api + web apps | direct-write `auth.ts` + handler mount + `@better-auth/cli generate --yes` | The de-facto TS auth standard; its own CLI `init` is too narrow (Next+SQLite only), but the generate path is fully non-interactive; depends on the Drizzle add-on |
| tRPC | A | api app (Hono/Elysia) + web client | direct-write v11 fetch-adapter file set | Tiny stable file set, zero codegen (pure type inference over the workspace); the classic pairing |
| oRPC | B | api app or standalone | direct-write | Bun-first with OpenAPI generation; smaller adoption than tRPC and recent org move — a second RPC flavor, not the first |

## Git & GitHub powers

Two S-complexity flags cover most of the value; one opt-in extra; the rest is documentation, not code:

| Capability | Tier | Shape | Notes |
| --- | --- | --- | --- |
| `groot init --github` | A | flag (+ `--public`) | After the initial commit: check `gh` presence + `gh auth status`, then `gh repo create <name> --private --source=. --remote=origin --push`. Ordering fix required: `--github` must hard-require the initial commit (today a missing git identity only downgrades it to a hint). Degrades to printed commands when gh is absent/unauthenticated |
| `--ci` workflow | A | flag → `.github/workflows/ci.yml` + `dependabot.yml` | The official Turborepo bun recipe: setup-bun, `bun install --frozen-lockfile`, `turbo build lint test --affected` (auto-detects GitHub Actions base refs). Actions SHA-pinned, paired with a bundled dependabot.yml (bun ecosystem is GA since Feb 2025 and updates bun.lock, plus github-actions ecosystem to keep the pins fresh) |
| `--hooks` | B | flag → lefthook.yml + root `prepare` script | lefthook over husky for bun monorepos: single binary, parallel, staged-file filtering without lint-staged. Key bun nuance: dependency postinstalls don't run — the root `"prepare": "lefthook install"` script is the reliable hook-install path. pre-commit: biome on staged files; pre-push: `turbo lint typecheck --affected`. Opt-in — hooks are team policy |
| `--changesets` | C | flag → `.changeset/` init only | Legit for workspaces that publish packages; noise for the app-centric majority. changesets' native bun publish support is in flight (PR #1789, release status unconfirmed) — revisit then; never scaffold the release workflow |
| PR/issue templates, CODEOWNERS | C | — | Near-zero value for fresh repos; CODEOWNERS actively harmful when wrong. Documentation recipes, not scaffolds |
| Branch protection / rulesets | C | — | `gh ruleset` is read-only; creation needs raw API payloads and injects team policy — a printed next-steps hint at most |

## The agent era

groot is already unusually agent-legible — the non-interactive contract, `--dry-run --json` everywhere, `doctor --json`, the published manifest schema, and [ci.md](./ci.md)'s agent recipes. The 2026 ecosystem shift (Nx deleting most of its MCP tools in favor of skills that teach agents to drive the CLI directly) validates that CLI-first substrate. What's worth adding, in leverage order:

| Capability | Tier | Shape | Notes |
| --- | --- | --- | --- |
| AGENTS.md from the manifest | A | scaffolded artifact | The cross-tool standard (read natively by Codex, Copilot, Cursor; canonical example is literally a Turborepo monorepo). Generate from groot.json: workspace layout, bun-only commands, turbo filter recipes, `groot add --dry-run --json` and `doctor --json` workflows. Keep under the 32 KiB discovery cap |
| CLAUDE.md import shim | A | scaffolded artifact | One line — `@AGENTS.md` — the officially documented pattern for the one major tool that doesn't read AGENTS.md natively |
| Sync on `add` | A | CLI behavior | Scaffolded agent files rot as the workspace changes; `groot add` regenerates the managed layout section (prior art: `nx configure-ai-agents`) |
| groot SKILL.md | B+ | authored + scaffolded | Agent Skills (agentskills.io, adopted by Claude Code, Cursor, Codex) — a `.claude/skills/groot/SKILL.md` teaching agents the workspace workflow; the Nx precedent shows skills beat MCP tools for teaching agents a CLI |
| `groot mcp` | B | CLI capability | A stdio MCP server as a thin typed adapter over the existing `--json` layer (tools: plan_init, add, doctor, read_manifest). Prior art: `ng mcp`, `nx mcp`. Timing: build on the MCP TypeScript SDK v2 (stable expected late July 2026, explicit bun support) rather than v1 |
| Scaffolded `.mcp.json` | B | scaffolded artifact | Wire `bunx create-groot mcp` into generated workspaces (read by Claude Code and Cursor) — only after `groot mcp` ships |
| llms.txt on the docs site | B | docs-site artifact | Cheap and standard for dev tools (llmstxt.org): generate llms.txt + llms-full.txt at docs build time. Honest framing: agent doc-fetchers use it; search crawlers demonstrably don't |
| `apps/agent` slot | B | scaffolded slot | Mastra is the one candidate with a fully flag-driven official generator (`create-mastra` / `mastra init`: `--components --llm --no-example`); LangGraph JS (`create-langgraph`) as the alternate flavor; Vercel AI SDK has templates but no generator — against groot's model |
| `.cursor/rules` + copilot-instructions | C | scaffolded artifact | Redundant in 2026 — both tools read AGENTS.md; generating them creates drift surface |

## Sequencing

The [roadmap](./roadmap.md) turns this ledger into four milestone themes: **v1.1 grow wider** (desktop slot + the A-tier scaffold wave), **v1.2 git & GitHub powers** (`--github`, `--ci`, `--hooks`), **v1.3 the agent era** (AGENTS.md trio, SKILL.md, `groot mcp`, llms.txt, agent slot), and **v1.4 the add-on engine** (design + Drizzle, Better Auth, tRPC). Ordering is directional — demand signals (issues, scaffold requests) reshuffle it. Tier B/C candidates stay in this ledger and graduate on evidence: an upstream release (Nitro v3 GA, changesets bun publish), a verification probe (SolidStart's prompt), or demonstrated demand.
