---
"create-groot": minor
---

New v2 commands for creating, adopting and evolving projects: `groot inspect` (read-only discovery), `groot adopt` (register an existing Bun/TypeScript project without moving files or touching dirty/staged work), `groot migrate` (explicit v1 → v2), `groot plan add <capability>` and `groot plan context-sync` (previewable plans with exact file previews, dependencies, commands, environment contracts, preconditions and recovery limits), `groot apply` (journaled execution with stale-plan detection, a single-writer lock and idempotent re-apply), `groot status`, `groot resume` (crash-safe continuation) and `groot rollback` (refuses to overwrite later human edits). Every `--json` output is one result envelope with stable `GROOT_E_*` error ids and exit codes 6 (conflict), 7 (blocked) and 8 (locked); `groot schema` publishes the contracts.
