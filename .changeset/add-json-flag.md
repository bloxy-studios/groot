---
"create-groot": minor
---

`groot add --dry-run --json` — the manifest as `groot.json` would read after the add, on pure stdout: the same versioned schema `init --dry-run --json` emits, with the new scaffold as the final entry. Diagnostics and port-collision warnings route to stderr, so agents and CI can parse stdout directly. Machine-readable output now covers every command: `init`, `add`, and `doctor`.
