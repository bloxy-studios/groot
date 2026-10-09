---
"create-groot": major
---

**Breaking:** `groot init` now writes a version 2 `groot.json` (the v2 blueprint) — a strict superset of version 1: `createdWith`, `conventions` and `scaffolds` keep their v1 meaning, and new sections describe the project, apps, capabilities, decisions, environment contracts, verification, agent context and action policy. `init --dry-run --json` and `add --dry-run --json` emit the same document. `add`, `doctor` and `--preset` read both versions and `add` writes back the version it found; v1 workspaces are never migrated implicitly — `groot migrate` converts them explicitly. Tools that check `version === 1` must accept 2; pin `create-groot@1` to keep writing v1. A committed `groot.lock.json` now records the exact generator versions (and registry integrity) every scaffold was created with.
