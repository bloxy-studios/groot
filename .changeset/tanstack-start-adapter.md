---
"create-groot": minor
---

TanStack Start joins the web slot — `groot init --web tanstack-start` and `groot add tanstack-start` grow a Start app from the official `@tanstack/cli` (`tanstack create`, pinned to the 0.69 minor), fully silenced: `--framework React --package-manager bun --no-git --no-install --no-examples --no-toolchain --no-intent --yes` (all flags verified against the published CLI source). Port 3000 rides the template's own dev script — same default as Next, with the standard collision warning covering `add --path` coexistence — and doctor gains vite-config and dev-script-port checks. The template's plain `vite build` output (`dist/`) is turbo-cached. Schema framework enum grows `tanstack-start`; manifest stays version 1.
