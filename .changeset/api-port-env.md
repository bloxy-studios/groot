---
"create-groot": patch
---

Elysia, Hono and Fastify scaffolds now read their dev port as `Number(process.env.PORT ?? <assigned port>)`, so `PORT` (hosting platforms, `groot verify`'s runtime checks on ephemeral ports) overrides the assigned default. `groot doctor` compares the configured port number — older scaffolds with a bare port literal keep passing, and a port like `30011` no longer passes for `3001`.
