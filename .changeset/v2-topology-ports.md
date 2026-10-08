---
"create-groot": minor
---

`groot init --topology single` plants one app at the project root (certified end to end for `--api hono`). In a v2 workspace, `groot add` allocates the next free dev port when the new scaffold's default is taken and applies it (`--port` in the dev script, or the server source for Elysia/Hono/Fastify) instead of only warning; v1 workspaces keep the v1 warning.
