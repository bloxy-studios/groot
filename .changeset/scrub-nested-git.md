---
"create-groot": patch
---

Fix git nesting: generators can no longer leave a `.git` inside a scaffold. `create-expo-app` has no git-suppression flag and initializes a repo whenever it doesn't detect an enclosing one — always the case during `groot init`, where the root `git init` runs after generation — so every workspace with a mobile app grew a nested `apps/mobile/.git` (and `groot doctor` flagged it). The engine now removes any generator-created `.git` immediately after each scaffold grows, in both `init` and `groot add`. A `.git` that existed before the grow (`--dir-conflict merge` onto a directory you already track) is yours and is preserved. Existing workspaces with the problem: run the doctor-suggested fix (`rm -rf apps/mobile/.git`).
