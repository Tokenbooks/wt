---
name: wt
description: Manage git worktree isolation — create, list, remove worktrees with isolated databases, Redis, and ports
argument-hint: "[new|open|list|remove|doctor|setup|init] [args...]"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# wt — Git Worktree Isolation

You are managing git worktrees with isolated Postgres databases, Redis DB indexes, and ports using the `wt` CLI.

## Routing

Based on the first argument, perform one of the following:

### `init` — First-time setup for a repository

The user wants to set up `wt` in their project for the first time. Follow these steps exactly:

**Step 1: Discover the project**

Search the repository to find:
- All `.env` files (not `.env.example`): `find . -name '.env' -not -path '*/node_modules/*' -not -path '*/.git/*'`
- The `DATABASE_URL` value to extract the base database name (path segment after the port, before `?`)
- Any `REDIS_URL` values and their format (with or without trailing `/0`)
- All services and their default ports — check `package.json` scripts, `docker-compose.yml`, framework config files
- The package manager in use (`pnpm`, `npm`, `yarn`) — check for lockfiles

**Step 2: Map env vars to patch types**

For each `.env` file, examine every variable and classify:

| Variable contains | Patch type | Needs `service`? |
|---|---|---|
| Postgres connection URL (`postgresql://...`) | `database` | No |
| Redis connection URL (`redis://...`) | `redis` | No |
| Just a port number | `port` | Yes |
| A URL containing a service port (`http://localhost:3000/...`) | `url` | Yes |
| Anything else (API keys, secrets, flags) | Skip — do not patch | — |

**Step 3: Generate `wt.config.json`**

Build the config file at the repository root:

```json
{
  "baseDatabaseName": "<extracted from DATABASE_URL>",
  "baseWorktreePath": ".worktrees",
  "portStride": 100,
  "maxSlots": 15,
  "services": [
    { "name": "<service>", "defaultPort": <port> }
  ],
  "envFiles": [
    {
      "source": "<relative path to .env file>",
      "patches": [
        { "var": "<VAR_NAME>", "type": "<database|redis|port|url>", "service": "<name>" }
      ]
    }
  ],
  "postSetup": ["<install command>"],
  "autoInstall": true
}
```

Validation rules:
- Every `port` and `url` patch must have a `service` that exists in `services`
- `portStride` * `maxSlots` + max default port must be < 65535
- `baseDatabaseName` must match the actual DB name in `DATABASE_URL`

**Step 4: Install wt**

```bash
# Detect package manager and install
pnpm add -D @tokenbooks/wt
```

**Step 5: Update .gitignore**

Add `.worktree-registry.json` if not already present.

**Step 6: Add convenience scripts to root package.json**

```json
{
  "scripts": {
    "wt": "wt",
    "wt:new": "wt new",
    "wt:list": "wt list",
    "wt:doctor": "wt doctor"
  }
}
```

**Step 7: Create `.husky/post-checkout` hook** (if husky is installed)

```bash
#!/bin/bash
prev_head="$1"
new_head="$2"
is_branch="$3"
[ "$is_branch" = "0" ] && exit 0
git_common=$(git rev-parse --git-common-dir 2>/dev/null)
git_dir=$(git rev-parse --git-dir 2>/dev/null)
[ "$git_common" = "$git_dir" ] && exit 0
main_worktree=$(cd "$git_common/.." && pwd -P)
wt_bin="$main_worktree/node_modules/.bin/wt"
if [ ! -f "$wt_bin" ]; then
  wt_bin=$(command -v wt 2>/dev/null || true)
fi
if [ -z "$wt_bin" ]; then
  echo "Warning: wt CLI not found."
  exit 0
fi
echo "Setting up worktree environment..."
"$wt_bin" setup "$(pwd -P)" --json 2>/dev/null && echo "Worktree ready!" || {
  echo "Warning: Auto-setup failed. Run 'wt setup' manually."
  exit 0
}
```

Make it executable: `chmod +x .husky/post-checkout`

**Step 8: Smoke test**

```bash
wt list                              # Should show "No worktree allocations found."
wt doctor                            # Should show "All checks passed."
wt new test/wt-smoke --no-install    # Create a test worktree
wt list                              # Should show the allocation
wt remove test-wt-smoke              # Clean up
```

Present the results to the user.

---

### `open $1` — Open (or create) a worktree

Run:
```bash
wt open $1
```

Accepts a slot number (`1`) or branch name (`feat/auth`). If a branch isn't found in the registry, it creates a new worktree automatically.

Tip: use `cd $(wt open $1)` to jump into the worktree directory.

---

### `new $1` — Create a new worktree

Run:
```bash
wt new $1
```

If it fails, check `wt doctor` for diagnostics. Common issues:
- All slots occupied → suggest `wt list` to find stale ones, then `wt remove`
- Database connection failed → check that Postgres is running and `DATABASE_URL` in root `.env` is correct

---

### `list` — List all worktree allocations

Run:
```bash
wt list
```

---

### `remove [targets...]|--all` — Remove one or more worktrees

Run:
```bash
wt remove $@
```

Accepts paths or slots, including batch slot formats:
- `wt remove 1 2`
- `wt remove 1,2`
- `wt remove "1, 2"`
- `wt remove --all`

If the user wants to keep the database, use `--keep-db`.

---

### `doctor` — Diagnose issues

Run:
```bash
wt doctor
```

If issues are found, ask the user if they want to auto-fix:
```bash
wt doctor --fix
```

---

### `setup` — Set up an existing worktree

Run:
```bash
wt setup $1
```

Use this when a worktree was created with plain `git worktree add` instead of `wt new`.

---

### No arguments or unrecognized command

Show a brief help:

```
Available commands:
  /wt init              — Set up wt in a new repository (discovers env files, generates config)
  /wt new <branch>      — Create a worktree with isolated DB, Redis, and ports
  /wt open <slot|branch> — Open a worktree by slot or branch (creates if not found)
  /wt list              — List all worktree allocations
  /wt remove <targets...>|--all — Remove one or more worktrees and clean up resources
  /wt doctor            — Diagnose and fix environment issues
  /wt setup [path]      — Set up an existing worktree
```
