---
"create-groot": minor
---

The web wave completes: Nuxt and Vite join the web slot, bringing it to seven choices (Next.js, SvelteKit, TanStack Start, Astro, React Router, Nuxt, Vite). Nuxt rides the official `create-nuxt@3` with every non-interactive-required arg passed explicitly (the CLI enforces dir + template + packageManager + gitInit in non-TTY shells — verified in source), template `minimal`, port 3000, `NUXT_PUBLIC_CONVEX_URL` env plumbing, and `.output/` turbo-cached. Vite rides `create-vite@9` with the `react-ts` template pinned, `--no-interactive --no-immediate` (9.x's immediate mode would install and start dev), port 5173, and `VITE_CONVEX_URL`. Both get doctor config checks. Schema framework enum grows `nuxt` and `vite`; manifest stays version 1.
