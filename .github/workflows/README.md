# CI workflows intentionally disabled

This directory is empty on purpose. The original Convos workflows are
preserved for reference under `.github/workflows-upstream-archived/`.
GitHub Actions only runs `*.yml` / `*.yaml` files inside
`.github/workflows/`, so nothing in the archive directory executes.

## Re-enabling a workflow

Move the file you want back into this directory and edit it for your
fork (secrets, branch filters, etc.):

```bash
git mv .github/workflows-upstream-archived/swiftlint.yml .github/workflows/
git commit -am "Enable SwiftLint CI"
```

## Adding a new Goldilocks-specific workflow

Drop a fresh `.yml` file in this directory. It'll run on push/PR
against this fork only — never affects upstream Convos.

## Upstream sync notes

If `git merge upstream/dev` ever brings the workflow files back into
`.github/workflows/`, treat that as a merge conflict you resolve by
keeping the move (delete from `workflows/`, keep in `workflows-upstream-archived/`).
