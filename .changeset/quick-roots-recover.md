---
"create-groot": patch
---

Fix: Convex backends now typecheck — `convex dev` no longer fails with TS2688

The vendored `convex/tsconfig.json` declares `"types": ["node"]`, but the generated `packages/backend/package.json` was missing `@types/node`, so `convex dev`'s built-in typecheck failed on first login (`error TS2688: Cannot find type definition file for 'node'`). The dependency is now included (pin tracks the upstream Convex template), and the E2E suite typechecks scaffolded packages — not just installs them — so this class of bug can't ship again.

Also documented: Convex's optional AI-files step installs agent skills via `npx`, which npm's `devEngines` guard correctly rejects inside groot's bun-declared workspaces (`EBADDEVENGINES`) — cosmetic, Convex continues and prints a manual retry command.
