---
"create-groot": minor
---

Electron joins the desktop slot — `groot init --desktop electron` and `groot add electron` grow `apps/desktop` from `@quick-start/create-electron` (electron-vite's scaffolder: react-ts template, `--skip` for full silence; Forge's generator force-installs and can't be silenced). No declared dev port: electron-vite's renderer server is non-strict and self-wiring, unlike Tauri's contractual 1420. Turbo caches electron-vite's `out/` build. New doctor checks: electron.vite.config presence, and a blocked-postinstall detector (electron's runtime download runs under bun's default-trusted lifecycle list — verified in E2E — with a `bun pm trust electron` fix if that ever changes). Schema framework enum grows `electron`; manifest stays version 1.
