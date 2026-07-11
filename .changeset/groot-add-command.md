---
"create-groot": minor
---

`groot add <scaffold>` — grow an existing workspace with one more scaffold. The same grow → stitch → verify pipeline as `init` runs for just the new scaffold: occupancy-checked destinations (`--path` unlocks a second scaffold per slot), automatic cross-wiring (adding convex links the existing frontends to the backend), a persistent `groot.json` update with provenance preserved, and targeted rollback that removes only the new scaffold directory on generator failure. Flags: `--path`, `--no-install`, `--keep-failed`, `--dry-run`, `--verbose`.
