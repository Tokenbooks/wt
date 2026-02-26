# wt — Git Worktree Environment Isolation

A CLI tool that gives each git worktree its own Postgres database, Redis database index, ports, and `.env` files. Prevents worktrees from corrupting each other's data.

## The Problem

When you use `git worktree add` for parallel development, all worktrees share the same database, Redis instance, and ports. This means:

- Schema migrations in one worktree break another
- BullMQ/Redis queues collide across worktrees
- Two dev servers can't run simultaneously on the same port
- `.env` files point to the same resources everywhere

`wt` solves this by assigning each worktree an isolated **slot** (1–15) that determines its database name, Redis DB index, and port range.

## How It Works

Each worktree gets a numbered slot. The slot determines everything:

| Resource | Formula | Slot 0 (main) | Slot 1 | Slot 2 | Slot 3 |
|----------|---------|:-:|:-:|:-:|:-:|
| Database | `{baseName}_wt{slot}` | `mydb` | `mydb_wt1` | `mydb_wt2` | `mydb_wt3` |
| Redis DB | `slot` | `/0` | `/1` | `/2` | `/3` |
| Ports | `slot * stride + defaultPort` | 3000, 3001 | 3100, 3101 | 3200, 3201 | 3300, 3301 |

- **Database**: Created via `CREATE DATABASE ... TEMPLATE` (fast filesystem copy, not dump/restore)
- **Redis**: Uses a different DB index per worktree (Redis supports 0–15)
- **Ports**: Offset by `portStride` (default 100) per slot
- **Env files**: Copied from main worktree and patched with the slot's values

## Quick Start

### 1. Install

**Global** (available in all repos):

```bash
pnpm add -g @tokenbooks/wt
```

**Per-project** (recommended for teams — version-locked in package.json):

```bash
pnpm add -D @tokenbooks/wt
```

### 2. Create `wt.config.json`

Create this file in your repository root and commit it. See [Configuration Reference](#configuration-reference) for full details.

```json
{
  "baseDatabaseName": "myapp",
  "baseWorktreePath": ".worktrees",
  "portStride": 100,
  "maxSlots": 15,
  "services": [
    { "name": "web", "defaultPort": 3000 },
    { "name": "api", "defaultPort": 4000 }
  ],
  "envFiles": [
    {
      "source": ".env",
      "patches": [
        { "var": "DATABASE_URL", "type": "database" }
      ]
    },
    {
      "source": "backend/.env",
      "patches": [
        { "var": "DATABASE_URL", "type": "database" },
        { "var": "REDIS_URL", "type": "redis" },
        { "var": "PORT", "type": "port", "service": "api" }
      ]
    },
    {
      "source": "frontend/.env",
      "patches": [
        { "var": "PORT", "type": "port", "service": "web" },
        { "var": "API_URL", "type": "url", "service": "api" }
      ]
    }
  ],
  "postSetup": ["npm install"],
  "autoInstall": true
}
```

### 3. Add `.worktree-registry.json` to `.gitignore`

```bash
echo ".worktree-registry.json" >> .gitignore
```

### 4. Use it

```bash
# Create a worktree with full isolation
wt new feat/my-feature

# Jump into a worktree by slot or branch
cd $(wt open 1)
cd $(wt open feat/my-feature)

# List all worktree allocations
wt list

# Check health
wt doctor

# Clean up
wt remove feat-my-feature
```

### 5. Claude Code skill (optional)

The package ships with a `/wt` skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). To enable it, symlink from your project:

```bash
mkdir -p .claude/skills
ln -s ../../node_modules/@tokenbooks/wt/skills/wt/SKILL.md .claude/skills/wt.md
```

Then use `/wt init`, `/wt new feat/foo`, `/wt doctor`, etc. inside Claude Code.

## Commands

### `wt new <branch> [--slot N] [--no-install] [--json]`

Creates a new git worktree and sets up its isolated environment:

1. Allocates the next available slot (or uses `--slot N`)
2. Runs `git worktree add .worktrees/<slug> -b <branch>`
3. Creates a new Postgres database from the main DB as template
4. Copies all configured `.env` files, patching each with slot-specific values
5. Runs `postSetup` commands (unless `--no-install`)

### `wt open <slot-or-branch> [--no-install] [--json]`

Opens an existing worktree or creates one on the fly. Prints the worktree path to stdout for easy shell integration:

```bash
cd $(wt open 1)                    # by slot number
cd $(wt open feat/my-feature)      # by branch name (creates if not found)
```

- **Slot number**: Looks up the allocation and prints its path. Exits 1 if the slot is empty.
- **Branch name**: Scans allocations for a matching branch. If not found, creates a new worktree (like `wt new`).

Shell helper tip:

```bash
wto() { cd "$(wt open "$@")"; }
```

### `wt setup [path] [--no-install] [--json]`

Sets up an existing worktree that was created manually or by another tool. Useful when:

- You ran `git worktree add` directly
- A worktree's env files need regenerating
- Called automatically by the `post-checkout` hook

If the worktree already has a slot allocation, it reuses it.

### `wt remove <targets...> [--all] [--keep-db] [--json]`

Removes a worktree and cleans up its resources:

1. Drops the worktree's Postgres database (unless `--keep-db`)
2. Runs `git worktree remove`
3. Removes the allocation from the registry

Accepts either paths (`.worktrees/feat-my-feature`) or slot numbers (`3`), including batch formats:

- `wt remove 1 2`
- `wt remove 1,2`
- `wt remove "1, 2"`
- `wt remove --all`

### `wt list [--json]`

Shows all worktree allocations with their slot, branch, database, Redis DB, ports, and status (ok/stale).

### `wt doctor [--fix] [--json]`

Runs diagnostics:

- **Stale entries**: Registry points to a path that no longer exists
- **Missing databases**: Allocated DB doesn't exist in Postgres
- **Missing env files**: Expected env files not found in worktree
- **Orphaned databases**: `{baseName}_wt*` databases not in the registry

Use `--fix` to auto-repair stale entries and drop orphaned databases.

### JSON output

All commands support `--json` for machine-readable output:

```json
{
  "success": true,
  "data": { ... }
}
```

Or on error:

```json
{
  "success": false,
  "error": { "code": "NO_SLOTS", "message": "All 15 slots are occupied." }
}
```

## Configuration Reference

### `wt.config.json`

This file lives in your repository root and is committed to version control.

```typescript
{
  // Required: name of your main Postgres database
  "baseDatabaseName": string,

  // Directory for worktrees, relative to repo root (default: ".worktrees")
  "baseWorktreePath": string,

  // Port offset per slot (default: 100)
  "portStride": number,

  // Maximum number of concurrent worktrees (default: 15, max: 15)
  "maxSlots": number,

  // Services that need port allocation
  "services": [
    { "name": string, "defaultPort": number }
  ],

  // Env files to copy and patch for each worktree
  "envFiles": [
    {
      "source": string,        // Path relative to repo root
      "patches": [
        {
          "var": string,       // Env var name to patch
          "type": string,      // "database" | "redis" | "port" | "url"
          "service": string    // Required for "port" and "url" types
        }
      ]
    }
  ],

  // Commands to run in the worktree after env setup (default: [])
  "postSetup": string[],

  // Whether to run postSetup automatically (default: true)
  "autoInstall": boolean
}
```

### Patch Types

| Type | What it patches | Input | Output (slot 3) |
|------|----------------|-------|------------------|
| `database` | Replaces DB name in a Postgres URL | `postgresql://u:p@host:5432/myapp?schema=public` | `postgresql://u:p@host:5432/myapp_wt3?schema=public` |
| `redis` | Replaces or appends DB index in a Redis URL | `redis://:pass@host:6379/0` | `redis://:pass@host:6379/3` |
| `port` | Replaces the entire value with the allocated port | `4000` | `4300` |
| `url` | Replaces the port number inside a URL | `http://localhost:4000/api` | `http://localhost:4300/api` |

The `port` and `url` types require a `service` field that matches a name in `services`.

### `.worktree-registry.json`

Auto-managed file at the repo root. **Add to `.gitignore`** — it's machine-local.

```json
{
  "version": 1,
  "allocations": {
    "1": {
      "worktreePath": "/absolute/path/to/.worktrees/feat-auth",
      "branchName": "feat/auth",
      "dbName": "myapp_wt1",
      "redisDb": 1,
      "ports": { "web": 3100, "api": 4100 },
      "createdAt": "2026-02-17T14:30:00Z"
    }
  }
}
```

## Git Hook: Automatic Setup

Add a `post-checkout` hook so `wt setup` runs automatically when switching branches inside a worktree. With [Husky](https://typicode.github.io/husky/):

Create `.husky/post-checkout`:

```bash
#!/bin/bash

prev_head="$1"
new_head="$2"
is_branch="$3"

# Only run on branch checkout (not file checkout)
[ "$is_branch" = "0" ] && exit 0

# Detect if we're in a worktree (not main)
git_common=$(git rev-parse --git-common-dir 2>/dev/null)
git_dir=$(git rev-parse --git-dir 2>/dev/null)
[ "$git_common" = "$git_dir" ] && exit 0

# Resolve main worktree path
main_worktree=$(cd "$git_common/.." && pwd -P)

# Find wt: local install first, then global
wt_bin="$main_worktree/node_modules/.bin/wt"
if [ ! -f "$wt_bin" ]; then
  wt_bin=$(command -v wt 2>/dev/null || true)
fi

if [ -z "$wt_bin" ]; then
  echo "Warning: wt CLI not found. Install globally (pnpm add -g @tokenbooks/wt) or locally (pnpm add -D @tokenbooks/wt)."
  exit 0
fi

echo "Setting up worktree environment..."
"$wt_bin" setup "$(pwd -P)" --json 2>/dev/null && echo "Worktree ready!" || {
  echo "Warning: Auto-setup failed. Run 'wt setup' manually."
  exit 0
}
```

The hook checks for a local install first (`node_modules/.bin/wt`), then falls back to a global `wt` on PATH.

## Setup Guide for LLM Agents

If you are an LLM agent setting up `wt` for a repository, follow these steps:

### Step 1: Discover the project structure

Identify these from the repository:

- **Database URL format**: Search `.env` files for `DATABASE_URL`. Extract the database name (the path segment after the port, before `?`).
- **Redis URL format**: Search for `REDIS_URL`. Note whether it ends with `/0` or has no DB index.
- **Services and ports**: Find all dev server commands and their default ports. Check `package.json` scripts, `docker-compose.yml`, and framework configs.
- **Env files**: List all `.env` files (not `.env.example`). These are the files that need patching.

### Step 2: Map env vars to patch types

For each `.env` file, identify which variables need patching:

| If the variable contains... | Use patch type |
|----------------------------|----------------|
| A Postgres connection URL (`postgresql://...`) | `database` |
| A Redis connection URL (`redis://...`) | `redis` |
| Just a port number (`3000`) | `port` + service name |
| A URL with a port (`http://localhost:3000/...`) | `url` + service name |

Variables that don't match any pattern (API keys, secrets, feature flags) should NOT be patched.

### Step 3: Build `wt.config.json`

Using the discovered information, construct the config:

```
1. baseDatabaseName = the DB name from the main DATABASE_URL
2. services = each dev server as { name, defaultPort }
3. envFiles = each .env file with its patches
4. postSetup = the install command for the package manager (npm install, pnpm install, etc.)
```

Validate that:
- Every `port` and `url` patch has a `service` that exists in `services`
- The `portStride` (default 100) doesn't cause port collisions with other local services
- `maxSlots * portStride` doesn't push ports into reserved ranges (e.g., above 65535)

### Step 4: Install and test

```bash
# Install wt
pnpm add -D @tokenbooks/wt

# Add to .gitignore
echo ".worktree-registry.json" >> .gitignore

# Verify
wt list          # Should show "No worktree allocations found."
wt doctor        # Should show "All checks passed."

# Smoke test (creates a real worktree + database)
wt new test/wt-smoke --no-install
wt list          # Should show the new allocation
wt remove test-wt-smoke
wt list          # Should be empty again
```

### Step 5: Add convenience scripts (optional)

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

## Requirements

- Node.js >= 20.19.0
- PostgreSQL (running, accessible via `DATABASE_URL` in root `.env`)
- Redis (if using `redis` patch type)
- Git (for worktree operations)

## License

MIT
