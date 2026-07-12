---
"create-groot": minor
---

Astro joins the web slot — `groot init --web astro` and `groot add astro` grow an Astro app from the official `create-astro@5` (`--template minimal --no-install --no-git --no-ai --skip-houston --yes`, all flags verified against the published source). Port 4321 (astro dev's built-in default) is the matrix's only unique web port. Convex env plumbing writes `PUBLIC_CONVEX_URL` (Astro's `import.meta.env.PUBLIC_*` client prefix), `astro build`'s `dist/` is turbo-cached, and doctor checks the astro config. Documented caveat: under `--yes` create-astro silently redirects non-empty targets to a random directory — unreachable behind groot's fresh-destination guarantee, and now written down. Schema framework enum grows `astro`; manifest stays version 1.
