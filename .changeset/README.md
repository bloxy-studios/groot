# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).

Every change that affects the published `create-groot` package or the installers needs a changeset:

```sh
bunx changeset
```

Pick the bump by semver (breaking → `major`, feature → `minor`, fix → `patch`; [docs/stability.md](../docs/stability.md) defines what counts as breaking) and write a user-facing sentence — it becomes the changelog entry. The release workflow turns accumulated changesets into a "Version Packages" PR; merging that PR publishes to npm and builds release binaries. See [docs/maintainers.md](../docs/maintainers.md).

The repository is currently in **pre mode** (`pre.json`, tag `next`) for the v2 prerelease line — versions publish as `2.0.0-next.N` under the npm `next` dist-tag. See [docs/maintainers.md](../docs/maintainers.md#the-v2-prerelease-line-next).
