---
"create-groot": patch
---

`groot init --name ""` (or a blank name) is now a usage error (exit 2) reported before anything runs, instead of a late crash after the generators ran. With `--topology single`, `--keep-failed` now keeps the failed generator's partial output.
