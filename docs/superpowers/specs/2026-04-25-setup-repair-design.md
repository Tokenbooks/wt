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

### Idempotent plain `setup` for Docker

`ensureDockerServices` gains an optional `recreateServices?: readonly string[]`
parameter:

- **Omitted or empty array (idempotent path):** invoke
  `docker compose up -d --no-recreate --remove-orphans`. `--no-recreate`
  tells compose to leave any existing container alone even if config
  differs; only missing containers are created. Plain `wt setup` always
  uses this path.

- **Non-empty array (targeted recreate path, used by `--repair`):** invoke
  two commands so port handoff is clean:
  1. `docker compose stop <listed services>` — releases their ports.
  2. `docker compose up -d --force-recreate --no-deps <listed services>`
     — re-creates only the named services from the latest compose config.
  Then a final `docker compose up -d --no-recreate --remove-orphans` to
  ensure any unchanged services that happened to have stopped are brought
  back, and orphans are pruned.

The set of services to recreate during repair is computed by walking
`config.dockerServices`: a docker service needs recreate iff any of its
`ports[*].service` references a port whose value changed in
`portChanges`. Docker services whose mapped ports are unaffected stay
running, untouched.

A non-port repair concern (e.g., the user changed `dockerServices`
config but no port changed) is **out of scope** for this spec. They can
still trigger a full recreate by `wt remove --keep-db` + `wt setup`.

### Validation

| Combination                                | Result |
|--------------------------------------------|--------|
| `wt setup` (no flags), existing worktree   | Reuse registered ports. Docker uses the idempotent `--no-recreate` path: running services are left alone, missing ones are created. |
| `wt setup` (no flags), no existing entry   | Fresh allocation. Docker uses the same idempotent path (no existing containers, so all are created). |
| `wt setup --repair`, no existing entry     | Error: `--repair requires an existing worktree allocation`. |
| `wt setup --repair`, existing entry        | Re-allocate, apply changes (or report no changes). |
| `wt setup --dry-run`                       | Error: `--dry-run requires --repair`. |
| `wt setup --repair --dry-run`              | Preview only. |
| `wt setup --repair`, no ports change       | Print "No port changes needed" and skip env/Docker work (idempotent). |

## Output

### Human mode

```
Repair preview for slot 20 (cryptoacc_wt20):
  app                 5000 → 5005   in use by python3[12345]
  server              5001 (unchanged)
  slack-bot           5010 (unchanged)
  sync-exchanges      5002 (unchanged)
  sync-canton         5003 (unchanged)
  electric            5004 (unchanged)
  redis               8379 (unchanged)

[dry-run] No changes written. Re-run without --dry-run to apply.
```

When applied (no `--dry-run`), the same preview prints, then the env-patch
and Docker steps run, and the trailing line becomes the standard
`Worktree configured (slot 20):` summary.

When all ports are unchanged:

```
Repair check for slot 20: no port changes needed.
```

(In this case, env files and Docker are NOT touched. `postSetup` is also
skipped. Repair is a no-op when there is nothing to repair.)

### `postSetup` interaction

When repair applies real changes (any service's port changes), the
existing `postSetup` flow runs after env-patch and Docker just like in
fresh setup, gated by the `--install` / `--no-install` flag. The
rationale: the user's chosen `postSetup` commands are the canonical "make
this worktree usable again" steps; if dependencies don't need reinstalling,
the user can pass `--no-install` (their typical default during repair).

| Mode                                  | postSetup |
|---------------------------------------|-----------|
| `--repair --dry-run`                  | Never (no side effects in dry-run).  |
| `--repair`, no port changes           | Skipped (nothing to repair).         |
| `--repair`, ports changed, `--install` (default) | Runs.                  |
| `--repair`, ports changed, `--no-install`        | Skipped.               |

### JSON mode

The success payload gains a `repaired: true` field and `portDrifts: PortDrift[]`
covers any services that drifted from their natural port. A new
`portChanges` array reports per-service repaired transitions:

```json
{
  "success": true,
  "data": {
    "slot": 20,
    "...": "...",
    "portDrifts": [...],
    "portChanges": [
      { "service": "app", "from": 5000, "to": 5005, "reason": "in use by python3[12345]" }
    ],
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
- `src/commands/setup.ts` — accept `repair` and `dryRun` in `SetupOptions`,
  add validation, branch to a repair flow that calls
  `allocateServicePorts` with `excludeSlot=slot`, computes `portChanges`
  by comparing new vs registered, and either previews (dry-run) or writes
  (registry update, env re-render, Docker re-apply with the changed
  services list).
- `src/core/docker-services.ts` — extend `EnsureDockerServicesOptions`
  with `recreateServices?: readonly string[]`. Default invocation
  (`--no-recreate --remove-orphans`) when omitted/empty; targeted
  stop-then-force-recreate when populated.
- `src/cli.ts` — add `--repair` and `--dry-run` flags to the `setup`
  command.
- `src/commands/setup.spec.ts` — new test cases (see below).
- `__tests__/docker-services.spec.ts` (existing) — extend with cases
  asserting the right compose flags are passed for both modes.

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
