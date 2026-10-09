---
"create-groot": patch
---

`groot inspect` reports an unreadable, looping, or dangling `groot.json` as registration `invalid` with a next step instead of crashing, never reports text from inside a dotenv value (e.g. an unquoted PEM) as a variable name, reads zero-indent `pnpm-workspace.yaml` lists, and no longer follows untracked symlinks or opens FIFOs when fingerprinting the worktree. `groot adopt` records only an app's own port (never a database studio's or storybook's) and states the structural checks it already knows will fail. The CLI starts faster: v2 commands load on demand, so v1 commands and `bun create groot <dir>` never load the v2 core.
