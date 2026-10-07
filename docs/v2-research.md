# Groot v2 — refreshed research (2026-10-07)

> Status: **research record** for the v2 refactor. Facts below were verified on 2026-10-07 against primary sources (vendor docs, registry metadata, upstream source) and local probes on macOS (Intel) with Bun 1.4.0. The September 2026 plan's predictions were re-checked rather than reused. Decisions derived from these facts live in [v2-architecture.md](./v2-architecture.md).

## Bun

| Fact | Source | Consequence for Groot |
| --- | --- | --- |
| CI pins 1.3.14; 1.4.0 (2026-08-20) is the Rust rewrite; 1.4.1 fixes macOS signal/`EINTR`, compile, and Windows spawn regressions; 1.4.2 is latest | bun.com/blog (v1.4, v1.4.1, v1.4.2) | Test on both 1.3.14 and the local 1.4.x; recommend moving CI + `packageManager` to ≥ 1.4.2 together (avoid 1.4.0) |
| `proc.kill()`, `timeout`, `AbortSignal`, `killSignal` signal only the direct child; `detached: true` + `process.kill(-pgid)` reaches the whole tree | bun.com/docs/runtime/child-process; local probe | Every child runs detached; teardown sweeps the process group |
| Piped stdout written right before `process.exit()` can be truncated (oven-sh/bun#41782) | local probe (20–50% at 2 MB under load) | v2 runner awaits the stdout flush before exiting |
| New lockfiles from 1.4 are `lockfileVersion: 2`, unreadable by 1.3.14 | Bun 1.3.14 source; v1.4 notes | Keep the repo lockfile at v1 while CI is on 1.3.14 (verified: frozen install passes on 1.3.14) |
| Compiled binaries auto-load `.env` and `bunfig.toml` from the working directory unless built with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` | bun.com/docs/bundler/executables | Release builds should pass both flags (pending) |
| New workspaces default to the isolated linker; explicit `trustedDependencies` replaces the default allow-list | bun.com/docs/pm/isolated-installs, /pm/lifecycle | Recipes must work under isolated installs |
| `wx` lockfile creation had one winner in a 16-process race; fsync/rename/dir-fsync work | local probe | Writer lock + atomic writes as implemented |

## Generator pins

Series pins resolve with Bun's own rule (exact spec → that version; else `dist-tags.latest` if it satisfies; else the highest stable match), confirmed against `bun install --lockfile-only` for all 15 pinned generators. Exact resolutions on 2026-10-07 include `create-next-app` 16.4.0, `create-turbo` 2.11.7, `create-hono` 0.19.5, `sv` 0.16.6. Drift beyond issue #81: `create-nuxt` 4.0.0 (Node floor raised). Within the pin, `create-next-app` 16.4 enables Cache Components by default and writes `AGENTS.md`; `--turbopack` was never a declared flag. `create-expo-app@5` is a shim over an unbounded `create-expo` range (lock the real generator).

## Agent instructions and skills

| Host | Rule | Source |
| --- | --- | --- |
| Claude Code ≥ 2.1.277 | Reads `AGENTS.md` natively **only when no CLAUDE.md exists**; a CLAUDE.md with `@AGENTS.md` is the documented sharing pattern; imports resolve relative to the importing file (max depth 4); nested files load lazily | code.claude.com/docs/en/memory |
| Codex | `AGENTS.override.md` → `AGENTS.md` per directory from project root to cwd; **32 KiB combined budget**; no `@` imports | developers.openai.com/codex/guides/agents-md; codex-rs `agents_md.rs` |
| Skills | agentskills.io SKILL.md (`name` = dir, ≤ 64 chars; `description` ≤ 1024). Codex/Cursor/Copilot/Gemini read `.agents/skills`; Claude Code reads `.claude/skills` (not `.agents/skills`) | agentskills.io/specification; code.claude.com/docs/en/skills; developers.openai.com/codex/skills |

## Installed-agent interfaces

- **Claude Code** (`claude -p --output-format stream-json --verbose`): `--verbose` is mandatory for stream-json; pre-assign `--session-id`; explicit `--permission-mode` (headless default can be `auto` on third-party providers, and user settings may select `bypassPermissions`); `--permission-prompts none`, `--strict-mcp-config`, `--max-turns`, `--max-budget-usd`; OS sandbox for Bash via `--settings`. Judge outcomes by `result.is_error` + `terminal_reason` (an API 404 arrives as `subtype:"success"`, `is_error:true`). `total_cost_usd` is a client-side estimate. SIGINT exits 0 with or without a final result; SIGTERM exits 143. `claude auth status` returns JSON with exit 0/1. Model aliases are provider-dependent. Sources: code.claude.com/docs/en/headless, /cli-reference, Agent SDK types; local probes.
- **Codex** (`codex exec --json --sandbox <mode> -C <dir> -c approval_policy="never" -`, prompt on stdin): events `thread.started` (resume id), `item.*`, `turn.completed` (tokens only, no cost), `turn.failed`; non-fatal `error` events for retries. SIGINT exits 1 without a terminal event. Flags differ by version (`--ignore-user-config` absent in 0.116) — feature-detect from `--help`. `codex login status` exit 1 means "not logged in" **or** "config error". The TS SDK only wraps `codex exec`; `app-server` is the only interface with interrupts/approvals but is marked experimental. Sources: developers.openai.com/codex (exec, SDK, app-server); `@openai/codex-sdk` source.
- **ACP**: neither Claude Code nor Codex implements it natively (adapters wrap the Agent SDK / experimental app-server; ACP v2 is draft) → deferred.

## MCP

`@modelcontextprotocol/server` 2.x is stable (2.0.0 on 2026-07-27, 2.3.1 on 2026-10-05, Bun listed as supported); the v1 SDK is maintenance-only. Spec 2026-07-28 removes the `initialize` handshake; Claude Code speaks it while Codex still uses the 2025-06-18 handshake — the v2 SDK's stdio server serves both. Both clients show the model only `structuredContent` when present, so results must carry a summary and next steps. Neither client supports MCP tasks; Codex tool timeouts are 120–300 s and progress does not extend them → return operation ids, cap waits (~45 s), offer status/cancel tools. Probe: stdout stayed protocol-clean; cancellation stopped handlers; the SDK adds ≈ 1 MB to the compiled binary. Sources: npm registry, modelcontextprotocol.io spec, client source/issues; local probes.

## Reference stack (auth + typed persistence)

Primary candidate: **Bun + Hono + Drizzle ORM (bun:sqlite) + Better Auth (email/password, Drizzle adapter)**. A prototype with `better-auth` 1.7.7, `drizzle-orm` 0.45.3, `drizzle-kit` 0.31.11, `hono` 4.13.13 passed a 24-step live flow on 2026-10-07: unauthenticated requests 401; sign-up and session; protected create 201 and validation 400; per-user isolation (another user's delete → 404); altered/garbage cookies 401; cross-origin POST rejected (403); sign-out invalidates the session; sign-in works. Schema generation runs through `bunx --bun auth@1.7.7 generate`; migrations via `drizzle-kit generate` (offline) and the bun-sqlite migrator at runtime. **Not yet certified in Groot**: the recipe, its monorepo variant, and the Next.js alternative (Node runtime cannot use bun:sqlite) still need Groot-run evidence.

## Open / unverified

Windows and Linux behavior (process groups, `--no-orphans`, rename semantics) untested locally; Claude SIGTERM behavior documented but not probed; a successful Codex event stream could not be captured locally; whether Claude Code sends MCP cancellation on interrupt; Apache-2.0 notice obligations for bundling the MCP SDK.
