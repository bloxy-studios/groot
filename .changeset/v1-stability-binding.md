---
"create-groot": major
---

v1.0.0 — the stability contract is binding.

No behavior changes in this release: it seals the contract [docs/stability.md](https://github.com/bloxy-studios/groot/blob/main/docs/stability.md) defines. The `init`/`add`/`doctor` command set and every documented flag, the exit-code table, the versioned `groot.json` manifest schema, and the non-interactive + `--json` guarantees are covered by semver from here on — breaking any of them requires a major release. The covered surface is tripwired by the contract snapshot tests in `packages/cli/src/contract.test.ts`.
