---
"create-groot": minor
---

Certified capabilities and evidence-based verification: `data` (Drizzle ORM on bun:sqlite with static, previewable migrations) and `auth` (Better Auth email + password with a protected per-user example) for Hono on Bun, in single-app and monorepo projects. `groot verify` runs structural, build, runtime and product-flow profiles (sign-up → session → protected write → unauthorized rejection against the real app on an ephemeral port) and records redacted evidence tied to the checked revision; `groot evidence` reads it back.
