---
"create-groot": minor
---

`groot init --preset <path>` — replicate a workspace shape from any groot.json (a file, or a workspace directory containing one). The preset is the **selections source**: slot → framework comes from the manifest, validated exactly like a workspace manifest, while the workspace name, paths, ports, generator pins, and conventions come from the current CLI — a preset written by an older groot never pins stale generators. Explicit slot flags win over the preset; extra same-slot scaffolds (grown via `groot add --path`) surface as warnings. With a target directory given, a preset run is fully non-interactive.
