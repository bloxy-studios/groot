---
"create-groot": minor
---

Installed-agent tasks are contained more strictly: Claude Code runs with `--safe-mode`, an explicit tool list, and a sandbox that must start (Bash allow rules are enforced, the repository's git directory is write-protected); a repository guard blocks a task whose agent or pre-review checks changed refs, HEADs, or git configuration and hooks. Pre-review acceptance checks run with credential-like environment variables removed (no OS sandbox — stated in the evidence), task and integration worktrees install their own dependencies before checks, integration never fast-forwards past a blocked check, and an interrupted or orphaned runner is stopped and recovered safely. `groot task run --ready` reports a non-zero exit when ready tasks fail to start; `--wall-time` and `--accept-timeout` are capped at 24 hours.
