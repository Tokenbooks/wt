# wt — Git Worktree Environment Isolation

A CLI tool that gives each git worktree its own Postgres database, Docker services, ports, and `.env` files. Prevents worktrees from corrupting each other's data.

## The Problem

When you use `git worktree add` for parallel development, all worktrees share the same database, Redis instance, and ports. This means:

- Schema migrations in one worktree break another
- BullMQ/Redis queues collide across worktrees
- Two dev servers can't run simultaneously on the same port
- `.env` files point to the same resources everywhere

`wt` solves this by assigning each worktree an isolated **slot** that determines its database name, Docker Compose project, and port range.

## How It Works

Each worktree gets a numbered slot. The slot determines everything:

| Resource | Formula | Slot 0 (main) | Slot 1 | Slot 2 | Slot 3 |
|----------|---------|:-:|:-:|:-:|:-:|
| Database | `{baseName}_wt{slot}` | `mydb` | `mydb_wt1` | `mydb_wt2` | `mydb_wt3` |
| Docker project | `wt-<slot>-<repo>-<hash>` | shared/local | slot 1 group | slot 2 group | slot 3 group |
| Ports | `slot * stride + defaultPort` | 3000, 3001 | 3100, 3101 | 3200, 3201 | 3300, 3301 |

- **Database**: Created via `CREATE DATABASE ... TEMPLATE` (fast filesystem copy, not dump/restore)
- **Docker services**: Run in a dedicated Docker Compose project per worktree, grouped in Docker Desktop
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
  "maxSlots": 50,
  "services": [
    { "name": "web", "defaultPort": 3000 },
    { "name": "api", "defaultPort": 4000 },
    { "name": "electric", "defaultPort": 3004 },
    { "name": "redis", "defaultPort": 6379 }
  ],
  "dockerServices": [
    {
      "name": "redis",
      "image": "redis:8-alpine",
      "ports": [
        { "service": "redis", "target": 6379 }
      ],
      "command": ["redis-server", "--requirepass", "local_password"]
    },
    {
      "name": "electric",
      "image": "docker.io/electricsql/electric:subqueries-beta-7",
      "ports": [
        { "service": "electric", "target": 3000 }
      ],
      "environment": {
        "DATABASE_URL": "postgresql://user:password@host.docker.internal:5432/{{dbName}}?sslmode=disable",
        "ELECTRIC_INSECURE": "true",
        "ELECTRIC_USAGE_REPORTING": "false"
      }
    }
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
        { "var": "REDIS_URL", "type": "url", "service": "redis" },
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

# Clean up by path or slot
wt remove .worktrees/feat-my-feature

# Prune worktrees Git already considers stale
wt prune
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
2. Checks whether `origin/<branch>` exists; if it does, fetches it and creates a tracking local branch, otherwise creates a fresh local branch
3. Creates a new Postgres database from the main DB as template
4. Copies all configured `.env` files, patching each with slot-specific values
5. Starts configured Docker services after the slot database exists
6. Runs `postSetup` commands (unless `--no-install`)

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
2. Removes the managed Docker project for that slot
3. Runs `git worktree remove`
4. Removes the allocation from the registry

Accepts either paths (`.worktrees/feat-my-feature`) or slot numbers (`3`), not branch names, including batch formats:

- `wt remove 1 2`
- `wt remove 1,2`
- `wt remove "1, 2"`
- `wt remove --all`

### `wt prune [--dry-run] [--keep-db] [--json]`

Finds worktrees that Git already marks as prunable, then:

1. Cleans up `wt`-managed resources for matching registry entries
2. Drops their databases unless `--keep-db` is set
3. Removes managed Docker projects if present
4. Runs `git worktree prune`

This is mainly for worktrees that were deleted manually from disk instead of through `wt remove`.

Use `--dry-run` to preview what would be pruned.

### `wt list [--json]`

Shows all worktree allocations with their slot, branch, database, Docker project, ports, and status (ok/stale).

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
  "error": {
    "code": "NO_SLOTS",
    "message": "All 50 slots are occupied or blocked by ports already in use."
  }
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

  // Maximum number of concurrent worktrees (default: 50)
  "maxSlots": number,

  // Services that need port allocation.
  "services": [
    { "name": string, "defaultPort": number }
  ],

  // Docker services to run per worktree (default: []).
  // wt renders this into an internal Docker Compose project named
  // wt-<slot>-<repo>-<hash>, so Docker Desktop groups them together.
  "dockerServices": [
    {
      "name": string,
      "image": string,
      "restart": "no" | "always" | "unless-stopped" | "on-failure",
      "ports": [
        {
          "service": string,   // service name from "services"
          "target": number,    // container port
          "host": string       // default "127.0.0.1"
        }
      ],
      "environment": { [key: string]: string },
      "command": string | string[],
      "volumes": string[],
      "extraHosts": string[]
    }
  ],

  // Env files to copy and patch for each worktree
  "envFiles": [
    {
      "source": string,        // Path relative to repo root
      "patches": [
        {
          "var": string,       // Env var name to patch
          "type": string,      // "database" | "port" | "url" | "branch"
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

`dockerServices` string values support these templates: `{{slot}}`, `{{dbName}}`, `{{branchName}}`, `{{worktreePath}}`, `{{mainRoot}}`, `{{projectName}}`, `{{ports.<service>}}`, and `{{services.<service>.port}}`.

### Patch Types

| Type | What it patches | Input | Output (slot 3) |
|------|----------------|-------|------------------|
| `database` | Replaces DB name in a Postgres URL | `postgresql://u:p@host:5432/myapp?schema=public` | `postgresql://u:p@host:5432/myapp_wt3?schema=public` |
| `port` | Replaces the entire value with the allocated port | `4000` | `4300` |
| `url` | Replaces the port number inside a URL | `http://localhost:4000/api` | `http://localhost:4300/api` |
| `branch` | Replaces the entire value with the current git branch | `main` | `feat/my-work` |

The `port` and `url` types require a `service` field that matches a name in `services`.

Legacy `type: "redis"` patches are no longer supported. Declare Redis in `dockerServices` and patch `REDIS_URL` with `type: "url"` instead.

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
      "docker": {
        "projectName": "wt-1-myapp-a1b2c3d4",
        "services": ["redis", "electric"]
      },
      "ports": { "web": 3100, "api": 4100, "redis": 6479 },
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
- **Redis URL format**: Search for `REDIS_URL`. If Redis should be per-worktree, declare Redis in both `services` and `dockerServices`, then patch `REDIS_URL` with `type: "url"`.
- **Services and ports**: Find all dev server commands and their default ports. Check `package.json` scripts, existing Docker Compose files, and framework configs.
- **Docker services**: Move per-worktree containers from Docker Compose files into `dockerServices`.
- **Env files**: List all `.env` files (not `.env.example`). These are the files that need patching.

### Step 2: Map env vars to patch types

For each `.env` file, identify which variables need patching:

| If the variable contains... | Use patch type |
|----------------------------|----------------|
| A Postgres connection URL (`postgresql://...`) | `database` |
| A Redis connection URL (`redis://...`) | `url` + service name (`redis`) |
| Just a port number (`3000`) | `port` + service name |
| A URL with a port (`http://localhost:3000/...`) | `url` + service name |

Variables that don't match any pattern (API keys, secrets, feature flags) should NOT be patched.

### Step 3: Build `wt.config.json`

Using the discovered information, construct the config:

```
1. baseDatabaseName = the DB name from the main DATABASE_URL
2. services = each dev server as { name, defaultPort }
3. dockerServices = each per-worktree container, with ports referencing `services`
4. envFiles = each .env file with its patches
5. postSetup = the install command for the package manager (npm install, pnpm install, etc.)
```

Validate that:
- Every `port` and `url` patch has a `service` that exists in `services`
- Every `dockerServices[].ports[].service` exists in `services`
- If using `dockerServices`, Docker is available locally
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
wt remove .worktrees/test-wt-smoke
wt list          # Should be empty again

# Opt-in Docker integration test for managed Docker services
pnpm test:docker
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
- Docker (if using `dockerServices`)
- Git (for worktree operations)

## License

MIT
