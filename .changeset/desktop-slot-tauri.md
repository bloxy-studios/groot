---
"create-groot": minor
---

New desktop slot with the Tauri v2 adapter — the first slot added since the original matrix, opening milestone v1.1. `groot init --desktop tauri` (or the new "Desktop app?" prompt) and `groot add tauri` grow `apps/desktop` from the official `create-tauri-app` (react-ts template, bun manager, workspace-derived bundle identifier), keeping the template's own coupled dev port 1420 (Vite strictPort + tauri.conf.json devUrl — unique in the matrix). Rust is only needed at dev time: scaffolding and `bun install` work without it, next-steps point at rustup, and `groot doctor` gains desktop checks (tauri config presence, devUrl/port consistency, a cargo warn, vite config tripwire). Additive manifest change: the schema's slot/framework enums grow `desktop`/`tauri` — existing manifests stay valid, `version` stays 1.
