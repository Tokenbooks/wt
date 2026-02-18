# Release Guide

## Quick Release

```bash
pnpm release:patch    # 0.1.2 → 0.1.3
pnpm release:minor    # 0.1.2 → 0.2.0
pnpm release:major    # 0.1.2 → 1.0.0
```

This runs lint, tests, and build, bumps `package.json`, commits, tags, and pushes. CI publishes to npm automatically when the tag lands.

## What the Script Does

1. Verifies you're on `main` with a clean working tree, up-to-date with remote
2. Runs `pnpm lint && pnpm test && pnpm build`
3. Writes the new version to `package.json`
4. Commits as `chore(release): X.Y.Z` and creates annotated tag `vX.Y.Z`
5. Pushes `main` with `--follow-tags`

CI then picks up the `v*` tag, validates it matches `package.json`, runs tests, and publishes with npm provenance.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Print what would happen without making changes |
| `--no-push` | Commit and tag locally but don't push |
| `--no-branch-check` | Allow release from a non-main branch (hotfix escape hatch) |

## Preview a Release

```bash
pnpm release:patch --dry-run
```

## Hotfix from a Non-Main Branch

```bash
pnpm release:patch --no-branch-check
```

## Troubleshooting

**"Working directory is not clean"** — Commit or stash your changes first.

**"Local main is not up-to-date with origin"** — Run `git pull --rebase` then retry.

**CI fails with "Tag vX.Y.Z != package.json"** — The tag was pushed without the matching version bump commit. Delete the remote tag (`git push origin :refs/tags/vX.Y.Z`), fix `package.json`, and re-release.
