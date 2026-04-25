# Port-Drift Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `wt new` / `wt setup` allocates ports, drift past in-use or
already-registered ports per service rather than failing or silently skipping
slots, and tell the user which process held the original port.

**Architecture:** A new `allocateServicePorts` function in
`src/core/slot-allocator.ts` replaces both `findAvailablePortSafeSlot` (auto-slot
path) and `findUnavailableServicePorts` (explicit-slot path). It probes upward
from the natural port `slot * stride + defaultPort`, skipping ports already
present in `registry.allocations[*].ports[*]` without OS probing, and binding
to test OS availability for the rest. Listener identification uses `lsof`
(best-effort, never throws). Both `new.ts` and `setup.ts` thread a
`PortDrift[]` list out through stderr logging and `--json` output. As a paired
fix, `setup.ts`'s existing-allocation branch starts reusing the registered
ports instead of recomputing them via the formula — invisible today, harmful
the moment drift exists.

**Tech Stack:** TypeScript, Node.js (`net`, `child_process`), Jest, lsof
(macOS/Linux).

**Reference spec:** `docs/superpowers/specs/2026-04-24-port-drift-allocation-design.md`

---

## File Structure

**Modify:**
- `src/types.ts` — add `PortDrift` and `AllocatedPorts` types.
- `src/core/slot-allocator.ts` — add `parseLsofOutput`, `describeListener`,
  `allocateServicePorts`. Remove `findUnavailableServicePorts` and
  `findAvailablePortSafeSlot`.
- `src/commands/new.ts` — replace both port-availability branches with
  `allocateServicePorts`; thread drifts into stderr + JSON output.
- `src/commands/setup.ts` — same swap on the fresh-allocation branch; on the
  existing-allocation branch reuse `existing[1].ports` instead of
  recomputing via `calculatePorts`.

**Modify (tests):**
- `__tests__/slot-allocator.spec.ts` — drop `findUnavailableServicePorts`
  test, add `parseLsofOutput` and `allocateServicePorts` tests.
- `src/commands/new.spec.ts` — replace deleted-function mocks with
  `allocateServicePorts`; add stderr-drift assertion and JSON-drift assertion.

**Create:**
- `src/commands/setup.spec.ts` — new file. Cover fresh-allocation drift flow
  and existing-allocation port-reuse regression.

---

## Task 1: Add Port-Drift Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add `PortDrift` and `AllocatedPorts` types**

In `src/types.ts`, add the following after the existing `PatchContext`
interface:

```ts
/** A single service whose port had to drift away from its natural slot port */
export interface PortDrift {
  readonly service: string;
  readonly requested: number;
  readonly assigned: number;
  readonly conflict:
    | { readonly kind: 'os'; readonly description: string }
    | { readonly kind: 'internal'; readonly slot: number; readonly service: string };
}

/** Result of allocating ports for a single slot's services */
export interface AllocatedPorts {
  readonly ports: Record<string, number>;
  readonly drifts: readonly PortDrift[];
}
```

- [ ] **Step 2: Verify the type-only addition compiles**

Run: `pnpm exec tsc --noEmit`
Expected: exits 0 with no output.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add PortDrift and AllocatedPorts"
```

---

## Task 2: Pure `parseLsofOutput` Helper

The drift reporter needs to identify the process holding a port. We split
this into a pure parser (testable without `lsof` on the system) and a thin
wrapper that shells out. Task 2 is the parser; Task 3 is the wrapper.

`lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn` produces records like:

```
p12345
cnode
n*:3200
```

where `p` is pid, `c` is command, `n` is the listening address. Multiple
listeners produce multiple `p`/`c`/`n` blocks. We parse the first complete
block.

**Files:**
- Modify: `src/core/slot-allocator.ts`
- Modify: `__tests__/slot-allocator.spec.ts`

- [ ] **Step 1: Write failing tests for `parseLsofOutput`**

Add this block at the end of `__tests__/slot-allocator.spec.ts` (before the
closing `});` of the outer `describe('slot-allocator', () => {`):

```ts
  describe('parseLsofOutput', () => {
    it('parses pid and command from a single listener', () => {
      const out = 'p12345\ncnode\nn*:3200\n';
      expect(parseLsofOutput(out)).toEqual({ pid: 12345, command: 'node' });
    });

    it('returns the first listener when multiple are reported', () => {
      const out = 'p12345\ncnode\nn127.0.0.1:3200\np67890\ncpython3\nn*:3200\n';
      expect(parseLsofOutput(out)).toEqual({ pid: 12345, command: 'node' });
    });

    it('returns null on empty output', () => {
      expect(parseLsofOutput('')).toBeNull();
    });

    it('returns null when only a name field is present', () => {
      expect(parseLsofOutput('n*:3200\n')).toBeNull();
    });
  });
```

Also add `parseLsofOutput` to the import block at the top of the file:

```ts
import {
  calculatePorts,
  calculateDbName,
  findAvailableSlot,
  findUnavailableServicePorts,
  validatePortPlan,
  parseLsofOutput,
} from '../src/core/slot-allocator';
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test -- slot-allocator`
Expected: 4 failing tests under `parseLsofOutput`, all with TypeScript or
import errors because `parseLsofOutput` is not exported yet.

- [ ] **Step 3: Implement `parseLsofOutput`**

Add to `src/core/slot-allocator.ts` (anywhere among the exports):

```ts
/**
 * Parse the output of `lsof -F pcn`. Returns the first listener's pid +
 * command, or null if the input doesn't contain a complete listener record.
 */
export function parseLsofOutput(output: string): { pid: number; command: string } | null {
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      // Encountering a new pid before completing the previous record means
      // the previous record was incomplete; reset.
      if (pid !== null && command === null) {
        pid = null;
      }
      const parsed = Number(line.slice(1));
      if (Number.isInteger(parsed)) {
        pid = parsed;
      }
    } else if (line.startsWith('c') && pid !== null && command === null) {
      command = line.slice(1);
    }
    if (pid !== null && command !== null) {
      return { pid, command };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test -- slot-allocator`
Expected: all 4 `parseLsofOutput` tests pass; existing tests continue to pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/slot-allocator.ts __tests__/slot-allocator.spec.ts
git commit -m "feat(slot-allocator): parse lsof -F output for listener identification"
```

---

## Task 3: `describeListener` Helper

A tiny wrapper around `lsof` that returns a human-readable string like
`"node[12345]"` or `"unknown process"` on failure. Best-effort, never
throws.

**Files:**
- Modify: `src/core/slot-allocator.ts`
- Modify: `__tests__/slot-allocator.spec.ts`

- [ ] **Step 1: Write failing test that binds a real socket and checks
  describeListener returns a non-empty, non-"unknown" string**

Add to `__tests__/slot-allocator.spec.ts` near the other `net`-based test
(inside `describe('slot-allocator', …)`):

```ts
  describe('describeListener', () => {
    it('returns a description for a real local listener', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP address.');
      }

      const description = await describeListener(address.port);

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });

      // Best-effort: on macOS/linux this should match `<command>[<pid>]`.
      // On platforms without lsof we fall back to "unknown process".
      expect(description).toMatch(/^(.+\[\d+\]|unknown process)$/);
    });

    it('returns "unknown process" when no one is listening', async () => {
      // Port 1 is reserved/unprivileged and almost certainly free.
      // lsof returns a non-zero exit when no match is found; we treat it
      // as "unknown process" rather than throwing.
      const description = await describeListener(1);
      expect(description).toBe('unknown process');
    });
  });
```

Add `describeListener` to the test file's import:

```ts
import {
  calculatePorts,
  calculateDbName,
  findAvailableSlot,
  findUnavailableServicePorts,
  validatePortPlan,
  parseLsofOutput,
  describeListener,
} from '../src/core/slot-allocator';
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `pnpm test -- slot-allocator`
Expected: 2 failing/erroring tests under `describeListener` due to the
missing export.

- [ ] **Step 3: Implement `describeListener`**

Add to `src/core/slot-allocator.ts` near the top of the file (after the
imports):

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
```

Then export the function:

```ts
/**
 * Best-effort identification of the process listening on `port`. Returns
 * `<command>[<pid>]` on darwin/linux when lsof finds a listener; returns
 * `"unknown process"` on any failure (no listener, lsof missing, parse
 * failure, unsupported platform). Never throws.
 */
export async function describeListener(port: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pcn'],
      { timeout: 2000 },
    );
    const parsed = parseLsofOutput(stdout);
    if (parsed) {
      return `${parsed.command}[${parsed.pid}]`;
    }
  } catch {
    // lsof returns non-zero when no match is found, or is missing entirely.
  }
  return 'unknown process';
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test -- slot-allocator`
Expected: both `describeListener` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/slot-allocator.ts __tests__/slot-allocator.spec.ts
git commit -m "feat(slot-allocator): describeListener via lsof, best-effort"
```

---

## Task 4: Core `allocateServicePorts`

**Files:**
- Modify: `src/core/slot-allocator.ts`
- Modify: `__tests__/slot-allocator.spec.ts`

- [ ] **Step 1: Write failing tests covering all five cases**

Add a new `describe` block to `__tests__/slot-allocator.spec.ts` (inside
`describe('slot-allocator', …)`):

```ts
  describe('allocateServicePorts', () => {
    const services = [
      { name: 'web', defaultPort: 3000 },
      { name: 'api', defaultPort: 4000 },
    ] as const;
    const stride = 100;

    function emptyRegistry(): Registry {
      return { version: 1, allocations: {} };
    }

    it('returns natural ports with no drift when everything is free', async () => {
      const result = await allocateServicePorts(2, services, stride, emptyRegistry());

      expect(result.ports).toEqual({ web: 3200, api: 4200 });
      expect(result.drifts).toEqual([]);
    });

    it('drifts a service whose natural port is bound at the OS level', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(3200, '127.0.0.1', () => resolve()));

      try {
        const result = await allocateServicePorts(2, services, stride, emptyRegistry());

        expect(result.ports.web).toBe(3201);
        expect(result.ports.api).toBe(4200);
        expect(result.drifts).toHaveLength(1);
        expect(result.drifts[0]).toMatchObject({
          service: 'web',
          requested: 3200,
          assigned: 3201,
          conflict: { kind: 'os' },
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('skips ports already in another slot\'s allocation without probing', async () => {
      const registry: Registry = {
        version: 1,
        allocations: {
          '1': {
            worktreePath: '/tmp/wt1',
            branchName: 'feat/a',
            dbName: 'db_wt1',
            ports: { web: 3200, api: 4100 },
            createdAt: '2026-04-25T00:00:00.000Z',
          },
        },
      };

      const result = await allocateServicePorts(2, services, stride, registry);

      // web's natural 3200 is reserved by slot 1; drift to 3201.
      // api's natural 4200 is free.
      expect(result.ports).toEqual({ web: 3201, api: 4200 });
      expect(result.drifts).toEqual([
        {
          service: 'web',
          requested: 3200,
          assigned: 3201,
          conflict: { kind: 'internal', slot: 1, service: 'web' },
        },
      ]);
    });

    it('drifts only the conflicting service in a multi-service config', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(4200, '127.0.0.1', () => resolve()));

      try {
        const result = await allocateServicePorts(2, services, stride, emptyRegistry());

        expect(result.ports.web).toBe(3200);
        expect(result.ports.api).toBe(4201);
        expect(result.drifts.map((d) => d.service)).toEqual(['api']);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('throws when a service exhausts the port space at 65535', async () => {
      // Service whose natural port is 65535, with that port internally
      // reserved — drift would have to go to 65536, which we refuse.
      const registry: Registry = {
        version: 1,
        allocations: {
          '1': {
            worktreePath: '/tmp/wt1',
            branchName: 'feat/a',
            dbName: 'db_wt1',
            ports: { edge: 65535 },
            createdAt: '2026-04-25T00:00:00.000Z',
          },
        },
      };
      const edgeServices = [{ name: 'edge', defaultPort: 65535 }] as const;

      await expect(
        allocateServicePorts(0, edgeServices, 0, registry),
      ).rejects.toThrow(/No available port for service 'edge'/);
    });
  });
```

Add `allocateServicePorts` to the imports at the top of the file.

- [ ] **Step 2: Run tests to confirm failures**

Run: `pnpm test -- slot-allocator`
Expected: 5 failing tests under `allocateServicePorts` due to missing
export.

- [ ] **Step 3: Implement `allocateServicePorts`**

Add to `src/core/slot-allocator.ts` (after `isPortAvailable`):

```ts
/**
 * Allocate ports for each service in the slot, drifting forward by 1 past
 * any port that is either already bound at the OS level or already in use
 * by another slot's allocation in the registry.
 *
 * Drift is per-service: only conflicting services move; the rest stay at
 * their natural slot port. Internal conflicts (registry collisions) are
 * resolved without probing the OS. OS conflicts trigger best-effort
 * listener identification via `describeListener`.
 *
 * Caps at port 65535. Throws if a service can't find a free port before
 * the ceiling.
 */
export async function allocateServicePorts(
  slot: number,
  services: readonly ServiceConfig[],
  stride: number,
  registry: Registry,
): Promise<AllocatedPorts> {
  // Build a map: port -> { slot, service } for every port already in the
  // registry across all allocations.
  const reserved = new Map<number, { slot: number; service: string }>();
  for (const [slotStr, allocation] of Object.entries(registry.allocations)) {
    const owningSlot = Number(slotStr);
    for (const [serviceName, port] of Object.entries(allocation.ports)) {
      reserved.set(port, { slot: owningSlot, service: serviceName });
    }
  }

  const ports: Record<string, number> = {};
  const drifts: PortDrift[] = [];

  for (const service of services) {
    const natural = slot * stride + service.defaultPort;
    let candidate = natural;
    let conflict: PortDrift['conflict'] | null = null;

    while (candidate <= 65535) {
      const internalOwner = reserved.get(candidate);
      if (internalOwner) {
        if (conflict === null) {
          conflict = {
            kind: 'internal',
            slot: internalOwner.slot,
            service: internalOwner.service,
          };
        }
        candidate++;
        continue;
      }

      if (await isPortAvailable(candidate)) {
        ports[service.name] = candidate;
        // Reserve this port for any later service in the same allocation
        // so two services in one slot can't pick the same drifted port.
        reserved.set(candidate, { slot, service: service.name });
        break;
      }

      if (conflict === null) {
        const description = await describeListener(candidate);
        conflict = { kind: 'os', description };
      }
      candidate++;
    }

    if (ports[service.name] === undefined) {
      throw new Error(
        `No available port for service '${service.name}' starting from ${natural}; reached 65535.`,
      );
    }

    if (candidate !== natural) {
      drifts.push({
        service: service.name,
        requested: natural,
        assigned: candidate,
        conflict: conflict!,
      });
    }
  }

  return { ports, drifts };
}
```

Also add the type imports at the top of the file:

```ts
import type { ServiceConfig, Registry, PortDrift, AllocatedPorts } from '../types';
```

(replacing the existing `import type { ServiceConfig, Registry } from '../types';`)

- [ ] **Step 4: Run tests to confirm pass**

Run: `pnpm test -- slot-allocator`
Expected: all 5 `allocateServicePorts` tests pass; all prior tests in the
file still pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/slot-allocator.ts __tests__/slot-allocator.spec.ts
git commit -m "feat(slot-allocator): allocateServicePorts with per-service drift"
```

---

## Task 5: Wire `allocateServicePorts` into `wt new`

Both branches in `new.ts` (auto-slot and explicit `--slot N`) collapse into
the same sequence: pick a slot, then call `allocateServicePorts`. Drift
lines log to stderr (suppressed under `--json`/`quiet`). The drift list
flows out through `CreateWorktreeResult` into the JSON success payload as
`portDrifts`.

**Files:**
- Modify: `src/commands/new.ts`
- Modify: `src/commands/new.spec.ts`

- [ ] **Step 1: Update `CreateWorktreeResult` and rewrite the slot/port
  block in `new.ts`**

In `src/commands/new.ts`:

Replace the import block:

```ts
import { readRegistry, writeRegistry, addAllocation } from '../core/registry';
import {
  calculatePorts,
  calculateDbName,
  findAvailablePortSafeSlot,
  findUnavailableServicePorts,
} from '../core/slot-allocator';
```

with:

```ts
import { readRegistry, writeRegistry, addAllocation } from '../core/registry';
import {
  calculateDbName,
  findAvailableSlot,
  allocateServicePorts,
} from '../core/slot-allocator';
```

Replace the `CreateWorktreeResult` interface:

```ts
export interface CreateWorktreeResult {
  readonly slot: number;
  readonly allocation: Allocation;
  readonly branchSelection: WorktreeBranchSelection;
  readonly portDrifts: readonly PortDrift[];
}
```

Add `PortDrift` to the type imports at the top of the file:

```ts
import type { Allocation, PortDrift } from '../types';
```

Replace the entire slot-determination + port-calculation block (lines
67-114 of the current file — the `if (options.slot !== undefined) { … }
else { … }` block, plus `const dbName = …` and `const ports = …`):

```ts
  // Determine slot — port availability no longer affects slot choice.
  let slot: number;
  if (options.slot !== undefined) {
    slot = parseInt(options.slot, 10);
    if (isNaN(slot) || slot < 1 || slot > config.maxSlots) {
      throw new Error(`Invalid slot: ${options.slot}. Must be 1-${config.maxSlots}.`);
    }
    if (String(slot) in registry.allocations) {
      throw new Error(`Slot ${slot} is already occupied.`);
    }
  } else {
    const available = findAvailableSlot(registry, config.maxSlots);
    if (available === null) {
      throw new Error(
        `All ${config.maxSlots} slots are occupied. ` +
        'Remove a worktree or increase maxSlots.',
      );
    }
    slot = available;
  }

  log(`Creating worktree for '${branchName}' in slot ${slot}...`);

  const basePath = path.join(mainRoot, config.baseWorktreePath);
  const branchSelection = resolveWorktreeBranch(
    branchName,
    (command) => log(`Running: ${command}`),
  );
  if (branchSelection.originCheckError) {
    warn(`Failed to check origin for '${branchName}': ${branchSelection.originCheckError}`);
  }
  log(describeBranchSelection(branchSelection));

  const dbName = calculateDbName(slot, config.baseDatabaseName);
  const { ports, drifts: portDrifts } = await allocateServicePorts(
    slot,
    config.services,
    config.portStride,
    registry,
  );
  for (const drift of portDrifts) {
    const detail =
      drift.conflict.kind === 'os'
        ? `in use by ${drift.conflict.description}`
        : `reserved by slot ${drift.conflict.slot} (${drift.conflict.service})`;
    warn(
      `Port ${drift.requested} (${drift.service}) ${detail}; ` +
      `using ${drift.assigned} instead.`,
    );
  }
  const databaseUrl = readDatabaseUrl(mainRoot);
```

Note this also moves `log("Creating worktree for ...")` and the branch
selection block before port allocation. That's intentional — drift logs
read more naturally when slot is announced first.

Replace the final `return` line:

```ts
  return { slot, allocation, branchSelection, portDrifts };
```

In `newCommand` (the JSON-output branch), update the success payload:

```ts
    if (options.json) {
      console.log(
        formatJson(
          success({
            slot,
            ...allocation,
            branchSource: branchSelection.source,
            branchSourceLabel: branchSelection.sourceLabel,
            portDrifts,
          }),
        ),
      );
    } else {
```

And destructure `portDrifts` at the top of `newCommand`:

```ts
    const { slot, allocation, branchSelection, portDrifts } = await createNewWorktree(branchName, {
      ...options,
      quiet: options.json,
    });
```

- [ ] **Step 2: Update mocks in `src/commands/new.spec.ts`**

Replace the slot-allocator mock block (lines 12-17):

```ts
jest.mock('../core/slot-allocator', () => ({
  calculatePorts: jest.fn(),
  calculateDbName: jest.fn(),
  findAvailablePortSafeSlot: jest.fn(),
  findUnavailableServicePorts: jest.fn(),
}));
```

with:

```ts
jest.mock('../core/slot-allocator', () => ({
  calculateDbName: jest.fn(),
  findAvailableSlot: jest.fn(),
  allocateServicePorts: jest.fn(),
}));
```

Replace the corresponding imports and aliases (lines 50-99). The
relevant section becomes:

```ts
import { addAllocation, readRegistry, writeRegistry } from '../core/registry';
import {
  calculateDbName,
  findAvailableSlot,
  allocateServicePorts,
} from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists, dropDatabase } from '../core/database';
import {
  ensureDockerServices,
  removeDockerServices,
} from '../core/docker-services';
import {
  getMainWorktreePath,
  createWorktree,
  getBranchName,
  removeWorktree,
  resolveWorktreeBranch,
} from '../core/git';
import { loadConfig } from './setup';
import { createNewWorktree, newCommand } from './new';
import type { Allocation, Registry, WtConfig } from '../types';
import type { WorktreeBranchSelection } from '../core/git';

const mockReadRegistry = readRegistry as jest.MockedFunction<typeof readRegistry>;
const mockWriteRegistry = writeRegistry as jest.MockedFunction<typeof writeRegistry>;
const mockAddAllocation = addAllocation as jest.MockedFunction<typeof addAllocation>;
const mockCalculateDbName = calculateDbName as jest.MockedFunction<typeof calculateDbName>;
const mockFindAvailableSlot = findAvailableSlot as jest.MockedFunction<
  typeof findAvailableSlot
>;
const mockAllocateServicePorts = allocateServicePorts as jest.MockedFunction<
  typeof allocateServicePorts
>;
const mockCopyAndPatchAllEnvFiles =
  copyAndPatchAllEnvFiles as jest.MockedFunction<typeof copyAndPatchAllEnvFiles>;
const mockCreateDatabase = createDatabase as jest.MockedFunction<typeof createDatabase>;
const mockDatabaseExists = databaseExists as jest.MockedFunction<typeof databaseExists>;
const mockDropDatabase = dropDatabase as jest.MockedFunction<typeof dropDatabase>;
const mockEnsureDockerServices = ensureDockerServices as jest.MockedFunction<
  typeof ensureDockerServices
>;
const mockRemoveDockerServices = removeDockerServices as jest.MockedFunction<
  typeof removeDockerServices
>;
const mockGetMainWorktreePath = getMainWorktreePath as jest.MockedFunction<typeof getMainWorktreePath>;
const mockCreateWorktree = createWorktree as jest.MockedFunction<typeof createWorktree>;
const mockGetBranchName = getBranchName as jest.MockedFunction<typeof getBranchName>;
const mockRemoveWorktree = removeWorktree as jest.MockedFunction<typeof removeWorktree>;
const mockResolveWorktreeBranch =
  resolveWorktreeBranch as jest.MockedFunction<typeof resolveWorktreeBranch>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
```

Replace every existing `mockFindAvailablePortSafeSlot.mockResolvedValue(2);`
with:

```ts
    mockFindAvailableSlot.mockReturnValue(2);
    mockAllocateServicePorts.mockResolvedValue({ ports: { web: 3200 }, drifts: [] });
```

(Note: in the rollback test block, the mock should be
`{ ports: { web: 3200, redis: 6579 }, drifts: [] }`.)

Replace every `mockCalculatePorts.mockReturnValue(...)` with the
appropriate `mockAllocateServicePorts.mockResolvedValue({ ports: ..., drifts: [] })`
form. Remove all references to `mockCalculatePorts`.

- [ ] **Step 3: Add a new test case asserting drift output**

Append inside `describe('new command branch selection', () => { … })`,
after the existing `it` blocks:

```ts
  it('logs drift lines to stderr and includes portDrifts in JSON output', async () => {
    mockResolveWorktreeBranch.mockReturnValue(originSelection());
    mockAllocateServicePorts.mockResolvedValue({
      ports: { web: 3201 },
      drifts: [
        {
          service: 'web',
          requested: 3200,
          assigned: 3201,
          conflict: { kind: 'os', description: 'node[12345]' },
        },
      ],
    });

    await newCommand('feat/auth', { json: true, install: false });

    expect(stderrOutput(stderrSpy)).toContain(
      'Port 3200 (web) in use by node[12345]; using 3201 instead.',
    );
    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: { portDrifts: unknown[] };
    };
    expect(output.success).toBe(true);
    expect(output.data.portDrifts).toEqual([
      {
        service: 'web',
        requested: 3200,
        assigned: 3201,
        conflict: { kind: 'os', description: 'node[12345]' },
      },
    ]);
  });
```

- [ ] **Step 4: Run new.spec.ts**

Run: `pnpm test -- new.spec`
Expected: all tests pass, including the new drift test.

- [ ] **Step 5: Run the full test suite + tsc to catch downstream breakage**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all tests pass and tsc reports no errors. Note that `setup.ts`
will still compile because `findAvailablePortSafeSlot` and
`findUnavailableServicePorts` are still exported from slot-allocator.ts;
Task 7 removes them after `setup.ts` is also migrated.

- [ ] **Step 6: Commit**

```bash
git add src/commands/new.ts src/commands/new.spec.ts
git commit -m "feat(new): use allocateServicePorts for port assignment with drift logging"
```

---

## Task 6: Wire `allocateServicePorts` into `wt setup` and Fix Existing-Allocation Port Reuse

Two changes in `setup.ts`:

1. **Fresh allocation:** swap to `allocateServicePorts`, log drifts, include
   `portDrifts` in JSON output.
2. **Existing allocation:** stop recomputing ports via `calculatePorts`; use
   the registered ports verbatim. This preserves drifted ports across
   re-runs of `wt setup` (e.g., from the `post-checkout` hook) and is the
   regression-fix companion to (1).

**Files:**
- Modify: `src/commands/setup.ts`
- Create: `src/commands/setup.spec.ts`

- [ ] **Step 1: Rewrite the slot/port block in `setup.ts`**

In `src/commands/setup.ts`:

Replace the import block:

```ts
import {
  calculatePorts,
  calculateDbName,
  findAvailablePortSafeSlot,
  findUnavailableServicePorts,
  validatePortPlan,
} from '../core/slot-allocator';
```

with:

```ts
import {
  calculateDbName,
  findAvailableSlot,
  allocateServicePorts,
  validatePortPlan,
} from '../core/slot-allocator';
```

Add `PortDrift` to the type imports:

```ts
import type { Allocation, PortDrift, WtConfig } from '../types';
```

Replace the slot-determination + port-calculation block (the `const
existing = …` through the `if (!existing) { findUnavailableServicePorts… }`
section, lines 111-147):

```ts
    // Reuse existing allocation or allocate a new slot
    const existing = findByPath(registry, worktreePath);
    let slot: number;
    let ports: Record<string, number>;
    let portDrifts: readonly PortDrift[];

    if (existing) {
      slot = existing[0];
      // Preserve any drifted ports the worktree was originally created
      // with — formula recomputation would silently overwrite them.
      ports = existing[1].ports;
      portDrifts = [];
    } else {
      const available = findAvailableSlot(registry, config.maxSlots);
      if (available === null) {
        const msg =
          `All ${config.maxSlots} slots are occupied. ` +
          'Remove a worktree or increase maxSlots.';
        if (options.json) {
          console.log(formatJson(error('NO_SLOTS', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
      slot = available;
      const allocated = await allocateServicePorts(
        slot,
        config.services,
        config.portStride,
        registry,
      );
      ports = allocated.ports;
      portDrifts = allocated.drifts;
      for (const drift of portDrifts) {
        const detail =
          drift.conflict.kind === 'os'
            ? `in use by ${drift.conflict.description}`
            : `reserved by slot ${drift.conflict.slot} (${drift.conflict.service})`;
        process.stderr.write(
          `Port ${drift.requested} (${drift.service}) ${detail}; ` +
          `using ${drift.assigned} instead.\n`,
        );
      }
    }

    const dbName = calculateDbName(slot, config.baseDatabaseName);
    const branchName = getBranchName(worktreePath);
```

Note: the original code had `const ports = calculatePorts(...)` and
separate `findUnavailableServicePorts` check. Both are now folded into the
fresh-allocation branch via `allocateServicePorts`.

Update the JSON success output to include `portDrifts`:

```ts
    if (options.json) {
      console.log(formatJson(success({ slot, ...allocation, portDrifts })));
    } else {
      console.log(formatSetupSummary(slot, allocation));
    }
```

- [ ] **Step 2: Create `src/commands/setup.spec.ts`**

Create the file with this content:

```ts
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('../core/registry', () => ({
  readRegistry: jest.fn(),
  writeRegistry: jest.fn(),
  addAllocation: jest.fn(),
  findByPath: jest.fn(),
}));

jest.mock('../core/slot-allocator', () => ({
  calculateDbName: jest.fn(),
  findAvailableSlot: jest.fn(),
  allocateServicePorts: jest.fn(),
  validatePortPlan: jest.fn(),
}));

jest.mock('../core/env-patcher', () => ({
  copyAndPatchAllEnvFiles: jest.fn(),
}));

jest.mock('../core/database', () => ({
  createDatabase: jest.fn(),
  databaseExists: jest.fn(),
}));

jest.mock('../core/docker-services', () => ({
  ensureDockerServices: jest.fn(),
}));

jest.mock('../core/git', () => ({
  getMainWorktreePath: jest.fn(),
  isMainWorktree: jest.fn(),
  getBranchName: jest.fn(),
}));

import { readRegistry, writeRegistry, addAllocation, findByPath } from '../core/registry';
import {
  calculateDbName,
  findAvailableSlot,
  allocateServicePorts,
} from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists } from '../core/database';
import { ensureDockerServices } from '../core/docker-services';
import { getMainWorktreePath, isMainWorktree, getBranchName } from '../core/git';
import { loadConfig, setupCommand } from './setup';
import type { Allocation, Registry, WtConfig } from '../types';

const mockReadRegistry = readRegistry as jest.MockedFunction<typeof readRegistry>;
const mockWriteRegistry = writeRegistry as jest.MockedFunction<typeof writeRegistry>;
const mockAddAllocation = addAllocation as jest.MockedFunction<typeof addAllocation>;
const mockFindByPath = findByPath as jest.MockedFunction<typeof findByPath>;
const mockCalculateDbName = calculateDbName as jest.MockedFunction<typeof calculateDbName>;
const mockFindAvailableSlot = findAvailableSlot as jest.MockedFunction<typeof findAvailableSlot>;
const mockAllocateServicePorts = allocateServicePorts as jest.MockedFunction<
  typeof allocateServicePorts
>;
const mockCopyAndPatchAllEnvFiles =
  copyAndPatchAllEnvFiles as jest.MockedFunction<typeof copyAndPatchAllEnvFiles>;
const mockCreateDatabase = createDatabase as jest.MockedFunction<typeof createDatabase>;
const mockDatabaseExists = databaseExists as jest.MockedFunction<typeof databaseExists>;
const mockEnsureDockerServices = ensureDockerServices as jest.MockedFunction<
  typeof ensureDockerServices
>;
const mockGetMainWorktreePath = getMainWorktreePath as jest.MockedFunction<typeof getMainWorktreePath>;
const mockIsMainWorktree = isMainWorktree as jest.MockedFunction<typeof isMainWorktree>;
const mockGetBranchName = getBranchName as jest.MockedFunction<typeof getBranchName>;

const config: WtConfig = {
  baseDatabaseName: 'myapp',
  baseWorktreePath: '.worktrees',
  portStride: 100,
  maxSlots: 50,
  services: [{ name: 'web', defaultPort: 3000 }],
  dockerServices: [],
  envFiles: [],
  postSetup: [],
  autoInstall: true,
};

describe('setup command', () => {
  let tmpDir: string;
  let worktreeDir: string;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-setup-test-'));
    worktreeDir = path.join(tmpDir, '.worktrees', 'feat-auth');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'wt.config.json'),
      JSON.stringify(config),
      'utf-8',
    );

    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    mockGetMainWorktreePath.mockReturnValue(tmpDir);
    mockIsMainWorktree.mockReturnValue(false);
    mockGetBranchName.mockReturnValue('feat/auth');
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} });
    mockCalculateDbName.mockReturnValue('myapp_wt2');
    mockDatabaseExists.mockResolvedValue(true);
    mockCreateDatabase.mockResolvedValue();
    mockEnsureDockerServices.mockReturnValue({ projectName: 'wt-2-myapp', services: [] });
    mockAddAllocation.mockImplementation((registry, slot, allocation) => ({
      ...registry,
      allocations: { ...registry.allocations, [String(slot)]: allocation },
    }));
    process.exitCode = 0;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('on fresh allocation, logs drift to stderr and includes portDrifts in JSON output', async () => {
    mockFindByPath.mockReturnValue(null);
    mockFindAvailableSlot.mockReturnValue(2);
    mockAllocateServicePorts.mockResolvedValue({
      ports: { web: 3201 },
      drifts: [
        {
          service: 'web',
          requested: 3200,
          assigned: 3201,
          conflict: { kind: 'os', description: 'node[12345]' },
        },
      ],
    });

    await setupCommand(worktreeDir, { json: true, install: false });

    const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stderr).toContain(
      'Port 3200 (web) in use by node[12345]; using 3201 instead.',
    );
    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: { portDrifts: unknown[]; ports: Record<string, number> };
    };
    expect(payload.success).toBe(true);
    expect(payload.data.ports).toEqual({ web: 3201 });
    expect(payload.data.portDrifts).toHaveLength(1);
  });

  it('on existing allocation, reuses registered ports verbatim and reports no drifts', async () => {
    const allocation: Allocation = {
      worktreePath: worktreeDir,
      branchName: 'feat/auth',
      dbName: 'myapp_wt2',
      ports: { web: 3207 }, // drifted in a previous run
      createdAt: '2026-04-25T00:00:00.000Z',
    };
    mockFindByPath.mockReturnValue([2, allocation]);

    await setupCommand(worktreeDir, { json: true, install: false });

    // Crucial: allocateServicePorts must NOT be called for an existing
    // allocation — otherwise re-running setup would re-drift.
    expect(mockAllocateServicePorts).not.toHaveBeenCalled();

    // ensureDockerServices receives the registered (drifted) ports, not
    // the formula-computed ones (would be 3200 here).
    expect(mockEnsureDockerServices).toHaveBeenCalledWith(
      expect.objectContaining({ ports: { web: 3207 } }),
    );

    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: { ports: Record<string, number>; portDrifts: unknown[] };
    };
    expect(payload.data.ports).toEqual({ web: 3207 });
    expect(payload.data.portDrifts).toEqual([]);
  });
});
```

- [ ] **Step 3: Run setup tests**

Run: `pnpm test -- setup.spec`
Expected: both tests pass.

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/commands/setup.ts src/commands/setup.spec.ts
git commit -m "feat(setup): use allocateServicePorts; reuse registered ports for existing allocation"
```

---

## Task 7: Remove Dead Code

With both `new.ts` and `setup.ts` migrated, the legacy port-availability
helpers are unused. Remove them (and the now-unused
`findUnavailableServicePorts` test) to keep the surface small.

**Files:**
- Modify: `src/core/slot-allocator.ts`
- Modify: `__tests__/slot-allocator.spec.ts`

- [ ] **Step 1: Confirm both helpers are unused**

Run: `pnpm exec grep -rn "findAvailablePortSafeSlot\|findUnavailableServicePorts" src __tests__`
Expected: only matches in `src/core/slot-allocator.ts` and the
corresponding test, no consumers in `src/commands` or other tests.

- [ ] **Step 2: Delete `findUnavailableServicePorts` and `findAvailablePortSafeSlot` from `src/core/slot-allocator.ts`**

Remove these two function definitions entirely. Keep `isPortAvailable` —
`allocateServicePorts` uses it.

- [ ] **Step 3: Delete the `findUnavailableServicePorts` test block from
  `__tests__/slot-allocator.spec.ts`**

Remove the entire `describe('findUnavailableServicePorts', () => { … })`
block and the `findUnavailableServicePorts` import.

- [ ] **Step 4: Run the full test suite + tsc**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all tests pass; tsc reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/slot-allocator.ts __tests__/slot-allocator.spec.ts
git commit -m "refactor(slot-allocator): drop findUnavailableServicePorts and findAvailablePortSafeSlot"
```

---

## Task 8: Final Verification

- [ ] **Step 1: Run lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: clean build, `dist/` produced, no tsc errors.

- [ ] **Step 4: Smoke-test against a real conflict**

In a separate terminal, occupy port `3100`:

```bash
python3 -m http.server 3100
```

In the repo root:

```bash
node dist/cli.js new test/wt-port-drift-smoke --no-install
```

Expected stderr contains a line like:
`Port 3100 (web) in use by Python[<pid>]; using 3101 instead.`

(Substitute a service from the project's actual `wt.config.json`. Repo
without a `wt.config.json` should skip this step.)

Then clean up:

```bash
node dist/cli.js remove .worktrees/test-wt-port-drift-smoke
```

Stop the python listener.

- [ ] **Step 5: Final commit (if smoke-test surfaced any tweaks)**

If steps 1-4 required any small fixes, commit them with a focused message.
Otherwise skip.

```bash
git status
# if clean, no commit needed
```
