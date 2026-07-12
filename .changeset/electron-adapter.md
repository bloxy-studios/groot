---
"create-groot": minor
---

Electron joins the desktop slot — `groot init --desktop electron` and `groot add electron` grow `apps/desktop` from `@quick-start/create-electron` (electron-vite's scaffolder: react-ts template, `--skip` for full silence; Forge's generator force-installs and can't be silenced). No declared dev port: electron-vite's renderer server is non-strict and self-wiring, unlike Tauri's contractual 1420. Turbo caches electron-vite's `out/` build. Bun lifecycle finding (verified empirically in E2E on bun 1.3.14): electron's runtime-download postinstall is NOT default-trusted — the stitch stage now writes `trustedDependencies: ["electron"]` into the workspace root so `bun install` produces a runnable app, and `groot doctor` detects a blocked runtime with a `bun pm trust electron` fix. Schema framework enum grows `electron`; manifest stays version 1.
