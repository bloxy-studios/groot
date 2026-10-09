---
"create-groot": patch
---

Security: compiled `groot` binaries no longer load a `.env` or `bunfig.toml` from the directory they run in, and they sweep their child process tree on exit.
