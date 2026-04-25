# Port-drift allocation for `wt new` / `wt setup`

## Problem

When `wt` creates or sets up a worktree, it computes ports as
`slot * portStride + service.defaultPort`. If any of those ports is already
bound by another process — including another `wt` worktree's services — the
current behavior either:

1. **Auto-slot path** (`findAvailablePortSafeSlot`): silently *skips* that
   slot and tries the next one. The user ends up in a higher slot for no
   visible reason, and the skipped slots are never reused even after the
   conflict goes away.
2. **Explicit `--slot N` path** (`findUnavailableServicePorts`): hard-errors
   with `Slot N has ports already in use: …`. The user has to free the port
   manually before retrying.

Both behaviors are surprising. The user wants the simpler rule: **accept the
slot, drift the conflicting ports forward by 1 until they're free, and tell
the user which process held the original port.**

## Solution

Replace the two existing port-availability paths with a single
**per-service drift** allocator.

### Slot selection

Slots are picked purely from the registry — first slot in `1..maxSlots` that
has no allocation. Port availability no longer affects slot selection.
`findAvailablePortSafeSlot` is removed; `findAvailableSlot` (already exists)
is used in both `new.ts` and `setup.ts`.

### Port allocation

For each configured service, starting from the natural port
`slot * portStride + service.defaultPort`, probe sequentially upward until a
port satisfies both:

- **OS-free**: a transient `net.createServer().listen(port, '127.0.0.1')`
  succeeds, AND
- **Not already in the registry**: not present in any
  `registry.allocations[*].ports[*]` value.

Drift is **per-service**. If `web`'s natural port is taken but `api`'s is
free, only `web` drifts. The result is a `Record<string, number>` where most
services usually sit at their natural port and only the conflicting ones
move.

The reserved-set is built once before allocation. Reserved ports are
**skipped without probing the OS** — we already know they're ours.

### Drift cap

Drift is unbounded up to **65535**. If a service exhausts the port space
without finding a free port, allocation fails with:

```
No available port for service '<name>' starting from <natural>; reached 65535.
```

This is a hard failure; the create/setup is rolled back as it would be for
any other allocation error.

### Reporting

Every drift produces one line on stderr **before** the "Creating worktree…"
log. Two formats:

- **OS conflict**:
  `Port 3200 (web) in use by <process>[<pid>]; using 3201 instead.`
- **Internal conflict** (port already in registry):
  `Port 3200 (web) reserved by slot <N> (<service>); using 3201 instead.`

When listener detection itself fails or the platform is unsupported:

`Port 3200 (web) in use by unknown process; using 3201 instead.`

Detection is best-effort and never throws. Implementation: `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn` on darwin and linux. We parse the `p`
(pid), `c` (command), `n` (name) fields. On any other platform, or if
`lsof` is missing/errors, we fall back to `unknown process`.

The drift list is also threaded out for `--json` output, attached to the
result under `data.portDrifts`:

```json
"portDrifts": [
  {
    "service": "web",
    "requested": 3200,
    "assigned": 3201,
    "conflict": { "kind": "os", "description": "node[12345]" }
  }
]
```

When there are no drifts, `portDrifts` is an empty array.

## Scope

### Files changed

- `src/core/slot-allocator.ts` — core change. New
  `allocateServicePorts(slot, services, stride, registry)` function.
  Internal `describeListener(port)` helper. Remove
  `findUnavailableServicePorts` and `findAvailablePortSafeSlot`. Keep
  `calculatePorts`, `calculateDbName`, `validatePortPlan`,
  `findAvailableSlot`, `isPortAvailable`.

- `src/commands/new.ts` — replace both the auto-slot
  (`findAvailablePortSafeSlot`) and explicit-slot
  (`findUnavailableServicePorts`) branches with a single sequence:
  1. Pick slot via `findAvailableSlot` (auto) or validate the explicit one.
  2. Call `allocateServicePorts` to get final ports + drift list.
  3. Log each drift to stderr (suppressed under `--json`/`quiet`).
  4. Carry the drift list into the result and `--json` output.

- `src/commands/setup.ts` — two changes:
  1. Fresh-allocation branch (no existing registry entry) calls
     `allocateServicePorts`, threads drifts into stderr and `--json`, same
     as `new.ts`.
  2. Existing-allocation branch (worktree already in registry) uses
     `existing[1].ports` directly instead of recomputing via
     `calculatePorts`. This preserves a worktree's drifted ports across
     re-runs of `wt setup` (e.g., from the `post-checkout` hook). Today
     this code path overwrites registered ports with formula values; that
     is a latent bug which this change exposes once drift exists, so we
     fix it here.

- `src/types.ts` — add `PortDrift` and `AllocatedPorts` types alongside the
  existing `PatchContext` etc.

### Tests

- `__tests__/slot-allocator.spec.ts` — new `allocateServicePorts` cases:
  - All ports free → no drift, returns natural ports.
  - One service's port held by an OS listener (test by binding a real
    socket) → drifts by 1; conflict object reports `kind: 'os'`.
  - One service's port appears in registry as another slot's allocation →
    drifts past it without probing the OS; conflict object reports
    `kind: 'internal'` with the owning slot/service.
  - Multi-service partial drift: web drifts, api stays.
  - Exhaustion: service whose natural port is `65535` and that port is
    taken → throws with the expected message.

- `src/commands/new.spec.ts` — update mocks to replace
  `findAvailablePortSafeSlot` and `findUnavailableServicePorts` with
  `allocateServicePorts`. Add an assertion that drift lines appear on
  stderr when drifts are returned. Add an assertion that
  `data.portDrifts` is present in the JSON success output.

- `src/commands/setup.spec.ts` — new test file (no setup-specific suite
  exists yet). Cover:
  - Fresh allocation: drift list appears on stderr and in JSON output.
  - Re-running setup on an existing allocation reuses the registered ports
    verbatim (regression guard for the formula-overwrite bug).

### Behaviorally removed

- The `Slot N has ports already in use: …` error from `wt new --slot N`.
- The same error path in `wt setup`.
- The "skip slot when its natural ports are taken" behavior of
  `findAvailablePortSafeSlot`.

## Edge cases

- **Slot 0 (main worktree)**: not affected. `wt new` and `wt setup` only
  allocate slots ≥ 1; the main worktree's ports are managed by the user.
- **Re-running `wt setup` on an already-allocated worktree**: reuses the
  registered ports verbatim. Drift only applies on fresh allocation. See
  the second `setup.ts` change above for why this is a behavioral fix in
  addition to a swap.
- **Two concurrent `wt new` processes**: not in scope. Same race window as
  today — two parallel runs can read the same registry, both pick the same
  drifted port, then one's docker fails to bind on start. The fix is the
  same registry-locking story it would always have been; this change does
  not make the race worse.
- **`lsof` returns multiple listeners** (e.g., IPv4 + IPv6): we report the
  first listener we see. Good-enough for human diagnosis.
- **Bind check race**: `isPortAvailable` succeeds, then docker binds it a
  millisecond later. Outside our control; docker's own error message will
  surface and rollback handles cleanup.

## Non-goals

- Persisting drift history. The natural port is recoverable from the
  formula plus the slot/service; the registry only stores the
  actually-assigned port.
- Rebalancing existing allocations when a port frees up. Drifted ports
  stay drifted for the life of the worktree.
- Cross-platform parity for listener identification. macOS and Linux both
  ship `lsof`; Windows reports `unknown process`.
- Port reservation for *future* slots. We only avoid ports currently in
  the registry, not the natural ports of unallocated slots.
