# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).

Every change that affects the published `create-groot` package or the installers needs a changeset:

```sh
bunx changeset
```

Pick the bump (pre-1.0: breaking → `minor`, feature → `minor`, fix → `patch`) and write a user-facing sentence — it becomes the changelog entry. The release workflow turns accumulated changesets into a "Version Packages" PR; merging that PR publishes to npm and builds release binaries. See [docs/maintainers.md](../docs/maintainers.md).
