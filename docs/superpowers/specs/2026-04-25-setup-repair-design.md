# `wt setup --repair`, `--dry-run`, and idempotent Docker

## Problem

Two related issues hit the same code path on `wt setup`:

### 1. A worktree allocation can drift out of sync with reality

- The allocation pre-dates port-drift (v0.4.1) and recorded purely formula
  ports; one of those ports is now externally occupied.
- Some other process has seized one of the slot's ports while the worktree
  was idle.
- An adjacent slot's allocation has been removed, freeing a previously
  drifted-around port.

Today `wt setup` on an existing allocation is a strict no-op for ports — it
reuses the registered values verbatim. There is no way to ask wt to refresh
the allocation against current OS/registry state without removing and
recreating the whole worktree.

### 2. Plain `wt setup` is not idempotent for Docker

`ensureDockerServices` currently invokes `docker compose up -d
--remove-orphans` with default recreate semantics: if compose config
differs from the running state, the affected service is recreated. Even
trivial generation differences (or upgrading to a wt version with subtly
different label/env output) cause a recreate. Worse, Docker occasionally
fumbles port handoff during recreation — the new container tries to bind
before the old one's port is released, producing:

```
Bind for 127.0.0.1:8379 failed: port is already allocated
```

Re-running an unchanged `wt setup` should never break a running worktree.

Users need a way to repair a worktree's port allocation in place (with a
preview so they can see what would change before committing) AND running
plain `wt setup` should be safe to repeat on a healthy worktree.

## Solution

Two new flags on `wt setup`:

### `--repair`

Re-allocate ports for an existing worktree as if creating it fresh now,
then write the result back to the registry, re-render env files, and
re-apply the Docker project (which restarts containers with the updated
port mappings if any changed).

Per-service drift uses the existing `allocateServicePorts` logic. The only
twist is that the slot's own currently-registered ports are excluded from
the reserved set so the allocator doesn't treat them as "in use by another
slot." In every other respect (start from natural formula port, drift past
OS-bound and other-slot-reserved ports, cap at 65535), the behavior is
identical to fresh allocation.

This is a **rebalancing** semantic: a service whose port was previously
drifted to e.g. 3505 because 3500 was busy will return to 3500 if 3500 is
now free. The user accepts this in exchange for explicitly asking for
repair.

### `--dry-run`

Prints the proposed reallocation and exits without writing anything. Only
meaningful with `--repair`. Without `--repair`, `--dry-run` is rejected
with a clear error message — there is no fresh-setup change set worth
previewing (a fresh `wt setup` is already deterministic for a given
config + registry state).

### Idempotent plain `setup` for Docker via per-service hashing

`wt setup` should "just work" — re-running it on a healthy worktree must
not break running containers, and changing `dockerServices` config (image,
command, env, etc.) must take effect on the next `wt setup` without a
flag and without losing the worktree directory.

`wt remove` is not an acceptable workaround because it deletes the
worktree directory and any uncommitted changes in it.

#### How

Per-service deterministic hashing of the rendered compose entries,
stored in the allocation. On every `wt setup`:

1. Render the compose config as today (pure function of config + slot +
   worktreePath + branchName + ports + dbName).
2. For each service, compute `hash = sha256(JSON.stringify(serviceEntry))`,
   truncated to a stable short form (12 hex chars). Include all rendered
   fields — labels, env, command, image, ports, volumes — so any change
   that would surface to the running container produces a different hash.
3. Compare to `allocation.docker.serviceHashes` (new field).
4. **`recreateServices`** = services whose stored hash differs from the
   current hash. Newly-added services (not in stored hashes) also count
   as needing creation, but the idempotent up path handles that for free.
5. After a successful `ensureDockerServices` call, update the allocation
   with the new hashes.

`ensureDockerServices` gains an optional `recreateServices?: readonly string[]`
parameter:

- **Omitted or empty (idempotent path):** invoke
  `docker compose up -d --no-recreate --remove-orphans`. `--no-recreate`
  tells compose to leave any existing container alone even if config
  differs at Docker's own diff level; only missing containers are
  created.

- **Non-empty (targeted recreate path):** invoke three commands so port
  handoff is clean:
  1. `docker compose stop <listed services>` — releases their ports.
  2. `docker compose up -d --force-recreate --no-deps <listed services>`
     — re-creates only the named services from the latest compose
     config.
  3. Final `docker compose up -d --no-recreate --remove-orphans` to
     ensure any unchanged services that happened to have stopped are
     brought back, and orphans are pruned.

#### Migration for existing allocations

Allocations created before this change have no `serviceHashes` field.
On the first `wt setup` after upgrade:

- Treat missing `serviceHashes` as "in sync" — do NOT recreate based on
  the comparison (we cannot know what was actually applied).
- Compute current hashes and store them.
- Subsequent runs use the stored hashes for diffing as normal.

This means a user upgrading from v0.4.1 with an out-of-date `dockerServices`
config will see one extra setup before changes propagate. Documented as a
known one-time effect.

#### Why this fixes the original failure

The user's case: `wt setup` on slot 20 → Docker recreates redis →
recreate fails on port-bind because the old container's port wasn't
released. With the new path:

- If redis's hash hasn't changed, `recreateServices` doesn't include it,
  the idempotent up runs, and Docker's `--no-recreate` prevents the
  problematic recreate path entirely.
- If redis's hash has changed (legitimate config change), we explicitly
  `stop redis` first, then `up --force-recreate redis`. The stop
  releases the port before the up needs it.

### Validation

| Combination                                | Result |
|--------------------------------------------|--------|
| `wt setup` (no flags), existing worktree   | Reuse registered ports. Auto-detect compose changes via per-service hashes: if any service's hash differs, that service is stop-then-force-recreated (clean port handoff); the rest stay running via the idempotent `--no-recreate` path. |
| `wt setup` (no flags), no existing entry   | Fresh allocation. All services are created via the idempotent up path. Hashes are stored. |
| `wt setup --repair`, no existing entry     | Error: `--repair requires an existing worktree allocation`. |
| `wt setup --repair`, existing entry        | Re-allocate ports excluding self-slot, then apply (the regular hash-diff path then naturally captures every service whose ports — or anything else — changed). |
| `wt setup --dry-run`                       | Error: `--dry-run requires --repair`. |
| `wt setup --repair --dry-run`              | Preview port changes + which docker services would be recreated. No writes. |
| `wt setup --repair`, no ports change AND no compose change | Print "No changes needed" and skip env/Docker/registry writes (idempotent). |

## Output

### Human mode

**Plain `wt setup` (no flags), nothing to do:**

Existing summary unchanged. If hashes all match, no extra output.

**Plain `wt setup` (no flags), docker services recreated:**

Before the standard summary, an extra line per recreated service:

```
Recreating docker service 'redis' (config changed).
Recreating docker service 'electric' (config changed).
Worktree configured (slot 20):
  ...
```

**`wt setup --repair` preview / apply:**

```
Repair preview for slot 20 (cryptoacc_wt20):
  app                 5000 → 5005   in use by python3[12345]
  server              5001 (unchanged)
  slack-bot           5010 (unchanged)
  sync-exchanges      5002 (unchanged)
  sync-canton         5003 (unchanged)
  electric            5004 (unchanged)
  redis               8379 (unchanged)

Docker services to recreate: redis (port changed)

[dry-run] No changes written. Re-run without --dry-run to apply.
```

When applied (no `--dry-run`), the same preview prints, then the
env-patch and Docker steps run, and the trailing line becomes the
standard `Worktree configured (slot 20):` summary.

When neither ports nor docker config changed:

```
Repair check for slot 20: no changes needed.
```

(In this case, env files and Docker are NOT touched. `postSetup` is
also skipped. Repair is a no-op when there is nothing to repair.)

### `postSetup` interaction

`postSetup` runs on every `wt setup` invocation when `--install` is set
(today's behavior, unchanged). With auto-detection, plain `wt setup` may
recreate docker services without any port repair; in that case
`postSetup` still runs if `--install` is set, on the assumption that the
user re-ran setup because they wanted the worktree refreshed.

| Mode                                                            | postSetup |
|-----------------------------------------------------------------|-----------|
| any `--dry-run`                                                 | Never (no side effects). |
| no changes detected (hashes match, no port repair)              | Skipped (nothing was applied). |
| changes applied AND `--install` (default)                       | Runs. |
| changes applied AND `--no-install`                              | Skipped. |

### JSON mode

Existing payload fields are preserved. New fields:

- `repaired: boolean` — `true` when invoked with `--repair`.
- `dryRun: boolean` — `true` when invoked with `--dry-run`.
- `portChanges: PortChange[]` — empty array on plain `setup`. On
  `--repair`, lists per-service `{ service, registered, proposed, reason }` for any
  port that changed (or `unchanged` reason for clarity if needed; an
  empty array on `--repair` means no port changes were needed).
- `portDrifts: PortDrift[]` — drifts relative to the natural formula
  port (existing semantic, populated only on fresh allocation or
  `--repair`).
- `recreatedDockerServices: string[]` — names of docker services that
  were recreated (or would be, in dry-run mode). Empty array means
  Docker was a no-op.

```json
{
  "success": true,
  "data": {
    "slot": 20,
    "...": "...",
    "portDrifts": [...],
    "portChanges": [
      { "service": "app", "registered": 5000, "proposed": 5005, "reason": "in use by python3[12345]" }
    ],
    "recreatedDockerServices": ["redis"],
    "repaired": true,
    "dryRun": false
  }
}
```

For `--dry-run`, the same payload is emitted with `dryRun: true` and no
side effects.

`portDrifts` describes drift relative to the natural formula port (the
existing semantic). `portChanges` describes delta relative to the
previously-registered ports (the new repair-specific concept). They can
overlap.

## Implementation

### Files

- `src/types.ts` — add `PortChange` interface (the per-service from→to
  diff used by repair output).
- `src/core/slot-allocator.ts` — add an `excludeSlot?: number` parameter
  to `allocateServicePorts`. When provided, the slot's allocation is
  filtered out of the reserved-ports map before drift kicks in.
- `src/schemas/registry.schema.ts` — extend the docker section of the
  allocation schema with optional `serviceHashes: Record<string, string>`.
- `src/commands/setup.ts` — accept `repair` and `dryRun` in `SetupOptions`,
  add validation. On every setup (repair or not), compute compose hashes,
  diff against allocation, derive `recreateServices`. For repair, also
  compute port repair as previously specified, union the recreate sets,
  and either preview (dry-run) or apply (registry update, env re-render,
  Docker re-apply).
- `src/core/docker-services.ts` —
  - Export `computeServiceHashes(compose: DockerComposeConfig): Record<string, string>`.
  - Extend `EnsureDockerServicesOptions` with `recreateServices?: readonly string[]`.
  - Default invocation (`--no-recreate --remove-orphans`) when omitted/empty;
    targeted stop-then-force-recreate-then-final-idempotent-up when
    populated.
  - Return the computed hashes alongside `{ projectName, services }` so
    the caller can persist them.
- `src/cli.ts` — add `--repair` and `--dry-run` flags to the `setup`
  command.
- `src/commands/setup.spec.ts` — new test cases (see below).
- `__tests__/docker-services.spec.ts` (existing) — extend with cases
  asserting the right compose flags are passed for both modes, plus
  hash determinism.

### Test cases (new)

1. `--repair --dry-run` with one OS-conflicting port: prints preview,
   asserts no registry write, no env-patch call, no Docker call.
2. `--repair --dry-run` with all ports clean: prints "no port changes
   needed."
3. `--repair` (no dry-run) with one OS-conflicting port: writes new
   allocation to registry, calls `copyAndPatchAllEnvFiles` with new
   ports, calls `ensureDockerServices` with new ports.
4. `--repair` with all ports clean: prints "no changes needed", does NOT
   call env-patch or Docker (idempotent).
5. `--repair` on a fresh (no existing) worktree: errors with the expected
   message; exit code 1.
6. `--dry-run` without `--repair`: errors with the expected message;
   exit code 1.
7. `excludeSlot` test in `__tests__/slot-allocator.spec.ts`: with the
   slot's own registered ports in the registry, calling
   `allocateServicePorts` with `excludeSlot=slot` ignores them and treats
   the natural ports as candidate.
8. Docker idempotence test (in `__tests__/docker-services.spec.ts`):
   `ensureDockerServices` without `recreateServices` invokes compose with
   `--no-recreate --remove-orphans`.
9. Docker targeted-recreate test: `ensureDockerServices` with
   `recreateServices: ['redis']` invokes `compose stop redis`, then
   `compose up -d --force-recreate --no-deps redis`, then a final
   idempotent up. (Verify via spy on the docker invocation, not by
   actually running Docker.)
10. Hash determinism test: `computeServiceHashes` on the same compose
    config returns identical values across runs; mutating any rendered
    field changes the hash for the affected service only.
11. Setup-with-hash-change test (in `setup.spec.ts`): existing allocation
    has stored hashes; current compose generation produces a different
    hash for `redis` only; `wt setup` (no flags) calls
    `ensureDockerServices` with `recreateServices: ['redis']` and writes
    the new hashes back to the registry.
12. Setup-migration test: existing allocation has no `serviceHashes`
    field. `wt setup` does NOT recreate any services (treats missing as
    in-sync), but DOES populate `serviceHashes` for next time.

### Output formatting

Text output is built in `src/output.ts` (existing module). Add a
`formatRepairPreview(slot, dbName, changes, dryRun)` helper that produces
the table format above.

## Documentation

### README updates

- `wt setup` command section gains a paragraph describing `--repair` and
  `--dry-run`.
- The "Setup Guide for LLM Agents" section's Step 4 verification list
  gains a smoke-test bullet for repair.

### `skills/wt/SKILL.md` updates

- Add `wt setup --repair --dry-run` and `wt setup --repair` to the
  command quick-reference / usage examples so Claude Code surfaces
  repair as part of the standard playbook.

## Why Repair Lives on `setup` (not `wt remove` + `wt new`)

The obvious-feeling alternative — "remove the worktree and create it
again" — is not acceptable because `wt remove` drops the worktree's
Postgres database (unless `--keep-db`) and deletes the worktree directory
itself. Users repairing a stale port allocation want to keep their data,
their git state, and their environment intact; they only want the port
mappings refreshed. Repair on `setup` is the right home: it touches only
ports + the things derived from ports (env files, Docker), leaves the
database and worktree directory alone, and reuses every other invariant
`setup` already enforces.

## Out of Scope

- A standalone `wt repair` or `wt doctor --fix-ports` command. Repair
  lives on `setup` because every other invariant `setup` enforces (DB,
  env, Docker, registry) needs to run alongside any port change anyway.
- Selective per-service repair (`--repair=app,server`). Always all-or-nothing
  for the slot.
- Detecting whether the OS-bound listener on a port is the worktree's
  own dev server vs a stranger. Repair always treats any listener as
  "must drift," accepting that an actively-running dev server would have
  its port reassigned. Documented as a consequence; users should run
  repair while their services are stopped if they want minimum churn.
- Surfacing previously-drifted ports that revert to natural with a
  distinct label. They appear in `portChanges` with the `to` port and a
  reason of `"natural port now free"`.
