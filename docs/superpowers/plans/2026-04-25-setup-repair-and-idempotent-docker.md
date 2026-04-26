# `wt setup --repair` + Idempotent Docker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `wt setup` idempotent for Docker via per-service compose-hash diffing, and add `wt setup --repair` (re-allocate ports for an existing worktree) and `--dry-run` (preview).

**Architecture:** Every `wt setup` computes per-service compose hashes, compares to hashes stored in the allocation, and recreates only services whose hash changed via a clean stop-then-up sequence. `--repair` re-runs `allocateServicePorts` excluding the slot's own current ports from the reserved set, then feeds the result through the same hash-diff pipeline. `--dry-run` prints the proposed changes and exits.

**Tech Stack:** TypeScript, Node.js, Jest, zod, Docker Compose CLI, SHA-256 (Node `crypto`).

**Reference spec:** `docs/superpowers/specs/2026-04-25-setup-repair-design.md`

---

## File Structure

**Modify:**

- `src/types.ts` — add `PortChange` interface.
- `src/schemas/registry.schema.ts` — extend the docker section of `allocationSchema` with optional `serviceHashes`.
- `src/core/slot-allocator.ts` — add optional `excludeSlot?: number` parameter to `allocateServicePorts`.
- `src/core/docker-services.ts` — add `computeServiceHashes`, extend `EnsureDockerServicesOptions` with `recreateServices?: readonly string[]`, extend `DockerServicesAllocation` with `serviceHashes`, change `ensureDockerServices` to honor `recreateServices` (idempotent vs targeted-recreate path) and return hashes.
- `src/output.ts` — add `formatRepairPreview` helper.
- `src/commands/setup.ts` — auto-detect docker recreation via hash diff (every setup), add `repair`/`dryRun` to `SetupOptions`, validation, repair path.
- `src/cli.ts` — add `--repair` and `--dry-run` flags to `setup`.

**Modify (tests):**

- `__tests__/slot-allocator.spec.ts` — add `excludeSlot` test case.
- `__tests__/docker-services.spec.ts` — add `computeServiceHashes` and `ensureDockerServices`-with-mocked-docker tests.
- `src/commands/setup.spec.ts` — add hash-diff cases, repair cases, dry-run cases, migration case, validation error cases.

**Modify (docs):**

- `README.md` — document `--repair` and `--dry-run`; document idempotent docker behavior.
- `skills/wt/SKILL.md` — add `wt setup --repair --dry-run` and `wt setup --repair` to the command quick-reference / playbook.

---

## Task 1: Add `PortChange` Type

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add the type**

In `src/types.ts`, after the existing `PortDrift` and `AllocatedPorts` interfaces, add:

```ts
/** A per-service port transition reported by `wt setup --repair` */
export interface PortChange {
  readonly service: string;
  readonly registered: number;
  readonly proposed: number;
  readonly reason: string;
}
```

- [ ] **Step 2: Verify compile**

Run: `pnpm exec tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add PortChange"
```

---

## Task 2: Extend Registry Schema with `serviceHashes`

**Files:**
- Modify: `src/schemas/registry.schema.ts`

- [ ] **Step 1: Extend the schema**

Replace the `docker` field of `allocationSchema` so it allows an optional `serviceHashes` map. Find:

```ts
  docker: z.object({
    projectName: z.string().min(1),
    services: z.array(z.string().min(1)),
  }).optional(),
```

Replace with:

```ts
  docker: z.object({
    projectName: z.string().min(1),
    services: z.array(z.string().min(1)),
    serviceHashes: z.record(z.string(), z.string()).optional(),
  }).optional(),
```

- [ ] **Step 2: Verify compile**

Run: `pnpm exec tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Run existing registry tests**

Run: `pnpm test -- registry`
Expected: all pass; existing registry.spec.ts tests cover allocations without `serviceHashes`, which is allowed because the field is optional.

- [ ] **Step 4: Commit**

```bash
git add src/schemas/registry.schema.ts
git commit -m "feat(schema): allow optional docker.serviceHashes on allocations"
```

---

## Task 3: `allocateServicePorts` — `excludeSlot` Parameter

**Files:**
- Modify: `src/core/slot-allocator.ts`
- Modify: `__tests__/slot-allocator.spec.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `__tests__/slot-allocator.spec.ts` inside the existing `describe('allocateServicePorts', …)` block, after the existing tests:

```ts
    it('treats the excluded slot\'s registered ports as not reserved', async () => {
      // Slot 2's registered ports include 3200 (web). Without excludeSlot
      // we'd see this as an internal conflict and drift; with
      // excludeSlot=2 we ignore it and treat 3200 as available.
      const registry: Registry = {
        version: 1,
        allocations: {
          '2': {
            worktreePath: '/tmp/wt2',
            branchName: 'feat/own',
            dbName: 'db_wt2',
            ports: { web: 3200, api: 4200 },
            createdAt: '2026-04-25T00:00:00.000Z',
          },
        },
      };

      const result = await allocateServicePorts(2, services, stride, registry, { excludeSlot: 2 });

      expect(result.ports).toEqual({ web: 3200, api: 4200 });
      expect(result.drifts).toEqual([]);
    });
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- slot-allocator`
Expected: 1 failure under `allocateServicePorts` complaining that the function signature doesn't accept a 5th argument.

- [ ] **Step 3: Implement `excludeSlot`**

In `src/core/slot-allocator.ts`, find the current signature:

```ts
export async function allocateServicePorts(
  slot: number,
  services: readonly ServiceConfig[],
  stride: number,
  registry: Registry,
): Promise<AllocatedPorts> {
```

Replace with:

```ts
export interface AllocateServicePortsOptions {
  readonly excludeSlot?: number;
}

export async function allocateServicePorts(
  slot: number,
  services: readonly ServiceConfig[],
  stride: number,
  registry: Registry,
  options: AllocateServicePortsOptions = {},
): Promise<AllocatedPorts> {
```

Then update the reserved-map construction inside the function. Find:

```ts
  const reserved = new Map<number, { slot: number; service: string }>();
  for (const [slotStr, allocation] of Object.entries(registry.allocations)) {
    const owningSlot = Number(slotStr);
    for (const [serviceName, port] of Object.entries(allocation.ports)) {
      reserved.set(port, { slot: owningSlot, service: serviceName });
    }
  }
```

Replace with:

```ts
  const reserved = new Map<number, { slot: number; service: string }>();
  for (const [slotStr, allocation] of Object.entries(registry.allocations)) {
    const owningSlot = Number(slotStr);
    if (options.excludeSlot !== undefined && owningSlot === options.excludeSlot) {
      continue;
    }
    for (const [serviceName, port] of Object.entries(allocation.ports)) {
      reserved.set(port, { slot: owningSlot, service: serviceName });
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- slot-allocator`
Expected: all tests pass (including the new one).

- [ ] **Step 5: Verify type check across the rest of the codebase**

Run: `pnpm exec tsc --noEmit`
Expected: clean. Existing callers (in `new.ts`, `setup.ts`) pass 4 args and don't need updating because the 5th is optional.

- [ ] **Step 6: Commit**

```bash
git add src/core/slot-allocator.ts __tests__/slot-allocator.spec.ts
git commit -m "feat(slot-allocator): add excludeSlot option to allocateServicePorts"
```

---

## Task 4: `computeServiceHashes` Helper

**Files:**
- Modify: `src/core/docker-services.ts`
- Modify: `__tests__/docker-services.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/docker-services.spec.ts` inside the outer `describe('docker-services', …)` block (before its closing `});`):

```ts
  describe('computeServiceHashes', () => {
    function configWithRedis(): WtConfig {
      return {
        ...config,
        dockerServices: [config.dockerServices[0]!], // redis only
      };
    }

    function buildOptions(overrides: Partial<{ ports: Record<string, number>; branchName: string }> = {}) {
      return {
        mainRoot: '/Users/dev/My Project',
        slot: 3,
        branchName: overrides.branchName ?? 'feat/electric',
        worktreePath: '/Users/dev/My Project/.worktrees/feat-electric',
        dbName: 'cryptoacc_wt3',
        ports: overrides.ports ?? { electric: 3304, redis: 6679 },
        config: configWithRedis(),
      };
    }

    it('returns one hash per docker service', () => {
      const compose = buildDockerComposeConfig(buildOptions());
      const hashes = computeServiceHashes(compose);

      expect(Object.keys(hashes)).toEqual(['redis']);
      expect(hashes.redis).toMatch(/^[a-f0-9]{12}$/);
    });

    it('produces identical hashes for identical compose configs', () => {
      const a = buildDockerComposeConfig(buildOptions());
      const b = buildDockerComposeConfig(buildOptions());

      expect(computeServiceHashes(a)).toEqual(computeServiceHashes(b));
    });

    it('produces different hashes when the rendered service differs', () => {
      const original = buildDockerComposeConfig(buildOptions());
      const portChanged = buildDockerComposeConfig(buildOptions({ ports: { electric: 3304, redis: 6699 } }));

      expect(computeServiceHashes(original).redis).not.toBe(computeServiceHashes(portChanged).redis);
    });
  });
```

Add `computeServiceHashes` to the import block at the top of the file:

```ts
import {
  buildDockerComposeConfig,
  computeServiceHashes,
  getDockerProjectName,
  usesDockerServices,
} from '../src/core/docker-services';
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- docker-services`
Expected: 3 new tests fail (or the suite errors) because `computeServiceHashes` is not exported.

- [ ] **Step 3: Implement `computeServiceHashes`**

In `src/core/docker-services.ts`, near the top of the file (after the existing imports and the `DOCKER_LABEL_PREFIX` constant), add:

```ts
/**
 * Compute a stable per-service hash of the rendered compose config. Used
 * by `wt setup` to detect which services have a changed configuration
 * and need to be recreated. The hash includes every rendered field
 * (image, labels, ports, environment, command, volumes, extra_hosts) so
 * any user-visible config change produces a new hash.
 */
export function computeServiceHashes(
  compose: DockerComposeConfig,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, service] of Object.entries(compose.services)) {
    const json = JSON.stringify(service);
    hashes[name] = crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
  }
  return hashes;
}
```

`crypto` is already imported at the top of the file.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- docker-services`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/docker-services.ts __tests__/docker-services.spec.ts
git commit -m "feat(docker-services): computeServiceHashes for compose-config diffing"
```

---

## Task 5: `ensureDockerServices` — `recreateServices` and Hash Return

`ensureDockerServices` gains a `recreateServices?: readonly string[]` option and now returns `serviceHashes` alongside the existing fields.

**Files:**
- Modify: `src/core/docker-services.ts`
- Modify: `__tests__/docker-services.spec.ts`

- [ ] **Step 1: Write the failing tests**

We need to mock `node:child_process`'s `execFileSync` to capture docker invocations. Add a new top-level `describe` to `__tests__/docker-services.spec.ts` (alongside the existing `describe('docker-services', ...)` — outside it, at the bottom of the file):

```ts
describe('ensureDockerServices invocation', () => {
  let calls: string[][] = [];

  beforeEach(() => {
    calls = [];
    jest.spyOn(child_process, 'execFileSync').mockImplementation((_cmd, args) => {
      calls.push([...(args as string[])]);
      return Buffer.from('');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const config: WtConfig = {
    baseDatabaseName: 'cryptoacc',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 25,
    services: [{ name: 'redis', defaultPort: 6379 }],
    dockerServices: [
      {
        name: 'redis',
        image: 'redis:8-alpine',
        restart: 'unless-stopped',
        ports: [{ service: 'redis', target: 6379, host: '127.0.0.1' }],
        environment: {},
        command: ['redis-server'],
        volumes: [],
        extraHosts: [],
      },
    ],
    envFiles: [],
    postSetup: [],
    autoInstall: true,
  };

  function runEnsure(extra: { recreateServices?: readonly string[] } = {}) {
    return ensureDockerServices({
      mainRoot: '/Users/dev/My Project',
      slot: 3,
      branchName: 'feat/x',
      worktreePath: '/Users/dev/My Project/.worktrees/x',
      dbName: 'cryptoacc_wt3',
      ports: { redis: 6679 },
      config,
      ...extra,
    });
  }

  it('uses the idempotent up path when recreateServices is omitted', () => {
    const result = runEnsure();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['compose', 'up', '-d', '--no-recreate', '--remove-orphans']));
    expect(result?.serviceHashes).toBeDefined();
    expect(Object.keys(result?.serviceHashes ?? {})).toEqual(['redis']);
  });

  it('uses the idempotent up path when recreateServices is empty', () => {
    runEnsure({ recreateServices: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['--no-recreate', '--remove-orphans']));
  });

  it('does targeted stop+force-recreate then a final idempotent up when recreateServices is non-empty', () => {
    runEnsure({ recreateServices: ['redis'] });

    expect(calls).toHaveLength(3);
    // 1. stop
    expect(calls[0]).toEqual(expect.arrayContaining(['compose', 'stop', 'redis']));
    // 2. force-recreate, no-deps, only the listed services
    expect(calls[1]).toEqual(expect.arrayContaining(['compose', 'up', '-d', '--force-recreate', '--no-deps', 'redis']));
    // 3. final idempotent up to bring back unchanged services and prune orphans
    expect(calls[2]).toEqual(expect.arrayContaining(['compose', 'up', '-d', '--no-recreate', '--remove-orphans']));
  });
});
```

Add the necessary imports at the top of the test file (or extend existing ones):

```ts
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as child_process from 'node:child_process';
import {
  buildDockerComposeConfig,
  computeServiceHashes,
  ensureDockerServices,
  getDockerProjectName,
  usesDockerServices,
} from '../src/core/docker-services';
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- docker-services`
Expected: the new `ensureDockerServices invocation` describe block has failing tests because `recreateServices` isn't honored and `serviceHashes` isn't returned.

- [ ] **Step 3: Update `EnsureDockerServicesOptions` and `DockerServicesAllocation`**

In `src/core/docker-services.ts`:

Find:
```ts
export interface EnsureDockerServicesOptions {
  readonly mainRoot: string;
  readonly slot: number;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly dbName: string;
  readonly ports: Record<string, number>;
  readonly config: WtConfig;
  readonly log?: (message: string) => void;
}
```

Replace with:
```ts
export interface EnsureDockerServicesOptions {
  readonly mainRoot: string;
  readonly slot: number;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly dbName: string;
  readonly ports: Record<string, number>;
  readonly config: WtConfig;
  readonly log?: (message: string) => void;
  /**
   * Names of docker services to stop-and-force-recreate. When omitted or
   * empty, only missing containers are created (`--no-recreate`).
   */
  readonly recreateServices?: readonly string[];
}
```

Find:
```ts
export interface DockerServicesAllocation {
  readonly projectName: string;
  readonly services: string[];
}
```

Replace with:
```ts
export interface DockerServicesAllocation {
  readonly projectName: string;
  readonly services: string[];
  readonly serviceHashes: Record<string, string>;
}
```

- [ ] **Step 4: Update `ensureDockerServices` body**

Find:
```ts
export function ensureDockerServices(
  options: EnsureDockerServicesOptions,
): DockerServicesAllocation | undefined {
  if (!usesDockerServices(options.config)) {
    return undefined;
  }

  const projectName = getDockerProjectName(options.mainRoot, options.slot);
  const compose = buildDockerComposeConfig(options);
  const filePath = writeComposeFile(projectName, compose);

  runDocker(['compose', '-f', filePath, '-p', projectName, 'up', '-d', '--remove-orphans']);
  const services = options.config.dockerServices.map((service) => service.name);
  options.log?.(`Started Docker project '${projectName}' (${services.join(', ')}).`);
  return { projectName, services };
}
```

Replace with:
```ts
export function ensureDockerServices(
  options: EnsureDockerServicesOptions,
): DockerServicesAllocation | undefined {
  if (!usesDockerServices(options.config)) {
    return undefined;
  }

  const projectName = getDockerProjectName(options.mainRoot, options.slot);
  const compose = buildDockerComposeConfig(options);
  const filePath = writeComposeFile(projectName, compose);
  const serviceHashes = computeServiceHashes(compose);

  const recreate = options.recreateServices ?? [];
  if (recreate.length > 0) {
    runDocker(['compose', '-f', filePath, '-p', projectName, 'stop', ...recreate]);
    runDocker([
      'compose',
      '-f',
      filePath,
      '-p',
      projectName,
      'up',
      '-d',
      '--force-recreate',
      '--no-deps',
      ...recreate,
    ]);
  }
  runDocker([
    'compose',
    '-f',
    filePath,
    '-p',
    projectName,
    'up',
    '-d',
    '--no-recreate',
    '--remove-orphans',
  ]);

  const services = options.config.dockerServices.map((service) => service.name);
  options.log?.(`Started Docker project '${projectName}' (${services.join(', ')}).`);
  return { projectName, services, serviceHashes };
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test -- docker-services`
Expected: all 3 invocation-tests + earlier hash + buildDockerComposeConfig tests pass.

- [ ] **Step 6: Run full suite + tsc**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: green. The tsc run will catch any place that destructures `DockerServicesAllocation` and requires updating; address any strictness errors at the call sites by accepting the new `serviceHashes` field. (Existing callers should be unaffected because they don't read fields they don't use.)

- [ ] **Step 7: Commit**

```bash
git add src/core/docker-services.ts __tests__/docker-services.spec.ts
git commit -m "feat(docker-services): recreateServices flag and serviceHashes return"
```

---

## Task 6: `formatRepairPreview` Output Helper

**Files:**
- Modify: `src/output.ts`
- Modify: `__tests__/output.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/output.spec.ts` (inside the existing `describe('output', ...)` block):

```ts
  describe('formatRepairPreview', () => {
    it('renders unchanged services and one repaired service', () => {
      const text = formatRepairPreview({
        slot: 20,
        dbName: 'cryptoacc_wt20',
        changes: [
          { service: 'app', registered: 5000, proposed: 5005, reason: 'in use by python3[12345]' },
          { service: 'server', registered: 5001, proposed: 5001, reason: 'unchanged' },
        ],
        recreatedDockerServices: ['redis'],
        dryRun: true,
      });

      expect(text).toContain('Repair preview for slot 20 (cryptoacc_wt20):');
      expect(text).toContain('app');
      expect(text).toContain('5000 → 5005');
      expect(text).toContain('in use by python3[12345]');
      expect(text).toContain('server');
      expect(text).toContain('(unchanged)');
      expect(text).toContain('Docker services to recreate: redis');
      expect(text).toContain('[dry-run] No changes written');
    });

    it('renders an apply-mode preview without the [dry-run] line', () => {
      const text = formatRepairPreview({
        slot: 20,
        dbName: 'cryptoacc_wt20',
        changes: [{ service: 'app', registered: 5000, proposed: 5005, reason: 'in use by node[1]' }],
        recreatedDockerServices: [],
        dryRun: false,
      });

      expect(text).not.toContain('[dry-run]');
    });

    it('renders the "no changes needed" form when nothing changed and no docker recreate', () => {
      const text = formatRepairPreview({
        slot: 20,
        dbName: 'cryptoacc_wt20',
        changes: [
          { service: 'app', registered: 5000, proposed: 5000, reason: 'unchanged' },
        ],
        recreatedDockerServices: [],
        dryRun: false,
      });

      expect(text).toContain('Repair check for slot 20: no changes needed.');
    });
  });
```

Add `formatRepairPreview` to the import at the top of the test file.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- output`
Expected: 3 new tests fail; `formatRepairPreview` is not exported.

- [ ] **Step 3: Implement `formatRepairPreview`**

In `src/output.ts`, add this export (the existing module has the `formatSetupSummary` helper for reference; place this nearby):

```ts
export interface RepairPreviewInput {
  readonly slot: number;
  readonly dbName: string;
  readonly changes: ReadonlyArray<{
    readonly service: string;
    readonly registered: number;
    readonly proposed: number;
    readonly reason: string;
  }>;
  readonly recreatedDockerServices: readonly string[];
  readonly dryRun: boolean;
}

export function formatRepairPreview(input: RepairPreviewInput): string {
  const anyChange = input.changes.some((c) => c.registered !== c.proposed);
  if (!anyChange && input.recreatedDockerServices.length === 0) {
    return `Repair check for slot ${input.slot}: no changes needed.\n`;
  }

  const lines: string[] = [];
  lines.push(`Repair preview for slot ${input.slot} (${input.dbName}):`);

  const nameWidth = Math.max(
    8,
    ...input.changes.map((c) => c.service.length),
  );

  for (const change of input.changes) {
    const name = change.service.padEnd(nameWidth);
    if (change.registered === change.proposed) {
      lines.push(`  ${name}  ${change.registered} (unchanged)`);
    } else {
      lines.push(
        `  ${name}  ${change.registered} → ${change.proposed}   ${change.reason}`,
      );
    }
  }

  if (input.recreatedDockerServices.length > 0) {
    lines.push('');
    lines.push(
      `Docker services to recreate: ${input.recreatedDockerServices.join(', ')}`,
    );
  }

  if (input.dryRun) {
    lines.push('');
    lines.push('[dry-run] No changes written. Re-run without --dry-run to apply.');
  }

  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- output`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/output.ts __tests__/output.spec.ts
git commit -m "feat(output): formatRepairPreview helper"
```

---

## Task 7: Wire `setup.ts` to Auto-Detect Docker Recreation

This task makes plain `wt setup` (no flags) idempotent: every run computes hashes, compares to the stored ones in the registry, and recreates only services whose hash changed. Migration: missing `serviceHashes` is treated as in-sync; current hashes are stored on first run.

**Files:**
- Modify: `src/commands/setup.ts`
- Modify: `src/commands/setup.spec.ts`

- [ ] **Step 1: Write the failing tests**

In `src/commands/setup.spec.ts`, modify the `jest.mock('../core/docker-services', …)` block to include `computeServiceHashes` and update mocks accordingly. Find:

```ts
jest.mock('../core/docker-services', () => ({
  ensureDockerServices: jest.fn(),
}));
```

Replace with:

```ts
jest.mock('../core/docker-services', () => ({
  ensureDockerServices: jest.fn(),
  buildDockerComposeConfig: jest.fn(),
  computeServiceHashes: jest.fn(),
}));
```

Update the imports/aliases:

```ts
import { ensureDockerServices, buildDockerComposeConfig, computeServiceHashes } from '../core/docker-services';
// ...
const mockBuildDockerComposeConfig = buildDockerComposeConfig as jest.MockedFunction<
  typeof buildDockerComposeConfig
>;
const mockComputeServiceHashes = computeServiceHashes as jest.MockedFunction<
  typeof computeServiceHashes
>;
```

Set baseline mock values in the existing `beforeEach`:

```ts
    mockBuildDockerComposeConfig.mockReturnValue({ services: {} });
    mockComputeServiceHashes.mockReturnValue({});
    mockEnsureDockerServices.mockReturnValue({ projectName: 'wt-2-myapp', services: [], serviceHashes: {} });
```

Then add new test cases (anywhere inside the existing `describe('setup command', …)`):

```ts
  it('auto-detects compose changes and recreates only the affected service', async () => {
    const dockerConfig: WtConfig = {
      ...config,
      services: [{ name: 'redis', defaultPort: 6379 }, { name: 'electric', defaultPort: 3004 }],
      dockerServices: [
        { name: 'redis', image: 'redis:8-alpine', restart: 'unless-stopped', ports: [], environment: {}, command: [], volumes: [], extraHosts: [] },
        { name: 'electric', image: 'electric:1', restart: 'unless-stopped', ports: [], environment: {}, command: [], volumes: [], extraHosts: [] },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'wt.config.json'), JSON.stringify(dockerConfig), 'utf-8');

    const allocation: Allocation = {
      worktreePath: worktreeDir,
      branchName: 'feat/auth',
      dbName: 'myapp_wt2',
      docker: {
        projectName: 'wt-2-myapp',
        services: ['redis', 'electric'],
        serviceHashes: { redis: 'OLDHASH', electric: 'electrichash' },
      },
      ports: { redis: 6479, electric: 3104 },
      createdAt: '2026-04-25T00:00:00.000Z',
    };
    mockFindByPath.mockReturnValue([2, allocation]);
    mockComputeServiceHashes.mockReturnValue({ redis: 'NEWHASH', electric: 'electrichash' });
    mockEnsureDockerServices.mockReturnValue({
      projectName: 'wt-2-myapp',
      services: ['redis', 'electric'],
      serviceHashes: { redis: 'NEWHASH', electric: 'electrichash' },
    });

    await setupCommand(worktreeDir, { json: true, install: false });

    expect(mockEnsureDockerServices).toHaveBeenCalledWith(
      expect.objectContaining({ recreateServices: ['redis'] }),
    );
    expect(mockWriteRegistry).toHaveBeenCalledWith(
      tmpDir,
      expect.objectContaining({
        allocations: expect.objectContaining({
          '2': expect.objectContaining({
            docker: expect.objectContaining({
              serviceHashes: { redis: 'NEWHASH', electric: 'electrichash' },
            }),
          }),
        }),
      }),
    );
  });

  it('treats missing serviceHashes as in-sync on first run after upgrade', async () => {
    const dockerConfig: WtConfig = {
      ...config,
      services: [{ name: 'redis', defaultPort: 6379 }],
      dockerServices: [
        { name: 'redis', image: 'redis:8-alpine', restart: 'unless-stopped', ports: [], environment: {}, command: [], volumes: [], extraHosts: [] },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'wt.config.json'), JSON.stringify(dockerConfig), 'utf-8');

    const allocation: Allocation = {
      worktreePath: worktreeDir,
      branchName: 'feat/auth',
      dbName: 'myapp_wt2',
      docker: {
        projectName: 'wt-2-myapp',
        services: ['redis'],
        // no serviceHashes — pre-upgrade allocation
      },
      ports: { redis: 6479 },
      createdAt: '2026-04-25T00:00:00.000Z',
    };
    mockFindByPath.mockReturnValue([2, allocation]);
    mockComputeServiceHashes.mockReturnValue({ redis: 'CURRENT' });
    mockEnsureDockerServices.mockReturnValue({
      projectName: 'wt-2-myapp',
      services: ['redis'],
      serviceHashes: { redis: 'CURRENT' },
    });

    await setupCommand(worktreeDir, { json: true, install: false });

    expect(mockEnsureDockerServices).toHaveBeenCalledWith(
      expect.objectContaining({ recreateServices: [] }),
    );
    expect(mockWriteRegistry).toHaveBeenCalledWith(
      tmpDir,
      expect.objectContaining({
        allocations: expect.objectContaining({
          '2': expect.objectContaining({
            docker: expect.objectContaining({
              serviceHashes: { redis: 'CURRENT' },
            }),
          }),
        }),
      }),
    );
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- setup.spec`
Expected: 2 new tests fail because `setupCommand` doesn't compute hashes / pass `recreateServices`.

- [ ] **Step 3: Implement the auto-detect path in `setup.ts`**

In `src/commands/setup.ts`, update the imports:

```ts
import {
  ensureDockerServices,
  buildDockerComposeConfig,
  computeServiceHashes,
} from '../core/docker-services';
```

In `setupCommand`, after `branchName` is computed and BEFORE the `ensureDockerServices` call, insert the hash-diff block. Find:

```ts
    const branchName = getBranchName(worktreePath);

    // Create database if it doesn't exist
    const databaseUrl = readDatabaseUrl(mainRoot);
    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      await createDatabase(databaseUrl, config.baseDatabaseName, dbName);
    }

    const docker = ensureDockerServices({
      mainRoot,
      slot,
      branchName,
      worktreePath,
      dbName,
      ports,
      config,
    });
```

Replace with:

```ts
    const branchName = getBranchName(worktreePath);

    // Create database if it doesn't exist
    const databaseUrl = readDatabaseUrl(mainRoot);
    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      await createDatabase(databaseUrl, config.baseDatabaseName, dbName);
    }

    // Compute current compose hashes and diff against stored ones to
    // decide which docker services need recreation. Missing stored
    // hashes (pre-upgrade allocation) are treated as in-sync — we don't
    // know what was actually applied, so we don't recreate anything;
    // we simply store the current hashes and the next config edit will
    // be detected normally.
    const composeConfig = buildDockerComposeConfig({
      mainRoot,
      slot,
      branchName,
      worktreePath,
      dbName,
      ports,
      config,
    });
    const currentHashes = computeServiceHashes(composeConfig);
    const storedHashes = existing?.[1].docker?.serviceHashes;
    const recreateServices = storedHashes
      ? Object.entries(currentHashes)
          .filter(([name, hash]) => storedHashes[name] !== undefined && storedHashes[name] !== hash)
          .map(([name]) => name)
      : [];

    const docker = ensureDockerServices({
      mainRoot,
      slot,
      branchName,
      worktreePath,
      dbName,
      ports,
      config,
      recreateServices,
    });
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- setup.spec`
Expected: the two new tests pass; existing setup tests still pass (their default mocks now route through the new path with empty/in-sync hashes).

- [ ] **Step 5: Run full suite + tsc**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/setup.ts src/commands/setup.spec.ts
git commit -m "feat(setup): auto-detect compose-config changes via per-service hashing"
```

---

## Task 8: `--repair` and `--dry-run` Flags

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/commands/setup.ts`
- Modify: `src/commands/setup.spec.ts`

- [ ] **Step 1: Add CLI flags**

In `src/cli.ts`, find the `setup` subcommand definition. The existing definition looks roughly like:

```ts
  .command('setup [path]')
  .description('Set up an existing worktree (DB, Docker, env files)')
  .option('--no-install', 'skip postSetup commands')
  .option('--json', 'output JSON')
  .action(async (target, opts) => {
    await setupCommand(target, { json: !!opts.json, install: opts.install !== false });
  });
```

Replace the relevant portion with:

```ts
  .command('setup [path]')
  .description('Set up an existing worktree (DB, Docker, env files)')
  .option('--no-install', 'skip postSetup commands')
  .option('--json', 'output JSON')
  .option('--repair', 're-allocate ports for an existing worktree, treating its own current ports as not-reserved')
  .option('--dry-run', 'preview what --repair would change without writing')
  .action(async (target, opts) => {
    await setupCommand(target, {
      json: !!opts.json,
      install: opts.install !== false,
      repair: !!opts.repair,
      dryRun: !!opts.dryRun,
    });
  });
```

(If the actual code structure differs, preserve the existing patterns and just add the two flags + thread them into the `setupCommand` call.)

- [ ] **Step 2: Update `SetupOptions` type and add validation**

In `src/commands/setup.ts`, find:

```ts
interface SetupOptions {
  readonly json: boolean;
  readonly install: boolean;
}
```

Replace with:

```ts
interface SetupOptions {
  readonly json: boolean;
  readonly install: boolean;
  readonly repair: boolean;
  readonly dryRun: boolean;
}
```

In `setupCommand`, very early (right after `targetPath` resolution, before any I/O), add:

```ts
    // Flag validation.
    if (options.dryRun && !options.repair) {
      const msg = '--dry-run requires --repair.';
      if (options.json) {
        console.log(formatJson(error('INVALID_OPTIONS', msg)));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }
```

Then immediately after `findByPath` and the slot-determination — i.e., when `existing === null` AND `options.repair` is true — error out:

Find:
```ts
    const existing = findByPath(registry, worktreePath);
    let slot: number;
    let ports: Record<string, number>;
    let portDrifts: readonly PortDrift[];

    if (existing) {
```

Replace with:
```ts
    const existing = findByPath(registry, worktreePath);

    if (options.repair && !existing) {
      const msg = '--repair requires an existing worktree allocation; remove --repair to set up fresh.';
      if (options.json) {
        console.log(formatJson(error('NO_ALLOCATION', msg)));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }

    let slot: number;
    let ports: Record<string, number>;
    let portDrifts: readonly PortDrift[];

    if (existing) {
```

- [ ] **Step 3: Add the repair flow**

The existing-allocation branch now has two sub-paths: plain (reuse ports) and repair (re-allocate). Find:

```ts
    if (existing) {
      slot = existing[0];
      ports = existing[1].ports;
      portDrifts = [];
    } else {
      // ... fresh allocation path
    }
```

Replace the `if (existing)` branch (keep the `else` branch as-is) with:

```ts
    if (existing) {
      slot = existing[0];
      if (options.repair) {
        const allocated = await allocateServicePorts(
          slot,
          config.services,
          config.portStride,
          registry,
          { excludeSlot: slot },
        );
        ports = allocated.ports;
        portDrifts = allocated.drifts;
      } else {
        ports = existing[1].ports;
        portDrifts = [];
      }
    } else {
      // ... existing fresh allocation path, unchanged
    }
```

- [ ] **Step 4: Compute repair preview and short-circuit on dry-run**

After the hash-diff block from Task 7 (where `recreateServices` is computed), add the repair preview computation. Insert immediately after the `recreateServices` calculation:

```ts
    // Compute portChanges (registered → proposed) for repair output.
    const portChanges: PortChange[] = options.repair && existing
      ? config.services.map((service) => {
          const registered = existing[1].ports[service.name] ?? 0;
          const proposed = ports[service.name] ?? 0;
          if (registered === proposed) {
            return { service: service.name, registered, proposed, reason: 'unchanged' };
          }
          const drift = portDrifts.find((d) => d.service === service.name);
          if (drift) {
            const reason = drift.conflict.kind === 'os'
              ? `in use by ${drift.conflict.description}`
              : `reserved by slot ${drift.conflict.slot} (${drift.conflict.service})`;
            return { service: service.name, registered, proposed, reason };
          }
          return { service: service.name, registered, proposed, reason: 'natural port now free' };
        })
      : [];
```

Make sure `PortChange` is imported from `'../types'`. Find:

```ts
import type { Allocation, PortDrift, WtConfig } from '../types';
```

Replace with:

```ts
import type { Allocation, PortChange, PortDrift, WtConfig } from '../types';
```

Then, when `options.repair` is true, print the preview. After the preview-computation block, add:

```ts
    if (options.repair) {
      const preview = formatRepairPreview({
        slot,
        dbName,
        changes: portChanges,
        recreatedDockerServices: recreateServices,
        dryRun: options.dryRun,
      });
      if (!options.json) {
        process.stdout.write(preview);
      }

      const anyChange = portChanges.some((c) => c.registered !== c.proposed);
      const noopRepair = !anyChange && recreateServices.length === 0;

      if (options.dryRun || noopRepair) {
        if (options.json) {
          console.log(
            formatJson(
              success({
                slot,
                ports,
                portDrifts,
                portChanges,
                recreatedDockerServices: options.dryRun ? recreateServices : [],
                repaired: true,
                dryRun: options.dryRun,
              }),
            ),
          );
        }
        return;
      }
    }
```

Add the `formatRepairPreview` import:

```ts
import { extractErrorMessage, formatJson, formatRepairPreview, formatSetupSummary, success, error } from '../output';
```

- [ ] **Step 5: Update the JSON success payload at the end of `setupCommand`**

The final `console.log(formatJson(success(…)))` needs to include `portChanges`, `recreatedDockerServices`, `repaired`, and `dryRun` (the last two always for repaired flows; on plain setup these are `false` and the docker-services field is the actually-recreated list). Find:

```ts
    if (options.json) {
      console.log(formatJson(success({ slot, ...allocation, portDrifts })));
    } else {
      console.log(formatSetupSummary(slot, allocation));
    }
```

Replace with:

```ts
    if (options.json) {
      console.log(
        formatJson(
          success({
            slot,
            ...allocation,
            portDrifts,
            portChanges,
            recreatedDockerServices: recreateServices,
            repaired: !!options.repair,
            dryRun: !!options.dryRun,
          }),
        ),
      );
    } else {
      console.log(formatSetupSummary(slot, allocation));
    }
```

- [ ] **Step 6: Update existing test expectations**

The existing setup.spec.ts tests do not pass `repair` or `dryRun` to `setupCommand`. To keep them green with the new `SetupOptions` shape, update each call site to add `repair: false, dryRun: false`. Search for `await setupCommand(` in `src/commands/setup.spec.ts` and add the two fields to every options object.

The cleanest pattern is to define a helper:

```ts
function setupOpts(overrides: Partial<{ json: boolean; install: boolean; repair: boolean; dryRun: boolean }> = {}): {
  json: boolean;
  install: boolean;
  repair: boolean;
  dryRun: boolean;
} {
  return { json: false, install: false, repair: false, dryRun: false, ...overrides };
}
```

Then replace each `await setupCommand(worktreeDir, { json: true, install: false })` with `await setupCommand(worktreeDir, setupOpts({ json: true }))`. Update the existing tests accordingly.

- [ ] **Step 7: Add new repair-specific tests**

In `src/commands/setup.spec.ts`, add these tests inside the existing `describe('setup command', …)`:

```ts
  it('--repair on existing allocation re-allocates ports and writes preview', async () => {
    const allocation: Allocation = {
      worktreePath: worktreeDir,
      branchName: 'feat/auth',
      dbName: 'myapp_wt2',
      docker: { projectName: 'wt-2-myapp', services: [], serviceHashes: {} },
      ports: { web: 3200 },
      createdAt: '2026-04-25T00:00:00.000Z',
    };
    mockFindByPath.mockReturnValue([2, allocation]);
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
    mockComputeServiceHashes.mockReturnValue({});
    mockEnsureDockerServices.mockReturnValue({ projectName: 'wt-2-myapp', services: [], serviceHashes: {} });

    await setupCommand(worktreeDir, setupOpts({ repair: true }));

    expect(mockAllocateServicePorts).toHaveBeenCalledWith(
      2,
      expect.any(Array),
      expect.any(Number),
      expect.any(Object),
      { excludeSlot: 2 },
    );
    expect(mockEnsureDockerServices).toHaveBeenCalled();
    expect(mockWriteRegistry).toHaveBeenCalled();
  });

  it('--repair --dry-run does not call writeRegistry, env-patch, or ensureDockerServices', async () => {
    const allocation: Allocation = {
      worktreePath: worktreeDir,
      branchName: 'feat/auth',
      dbName: 'myapp_wt2',
      docker: { projectName: 'wt-2-myapp', services: [], serviceHashes: {} },
      ports: { web: 3200 },
      createdAt: '2026-04-25T00:00:00.000Z',
    };
    mockFindByPath.mockReturnValue([2, allocation]);
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

    await setupCommand(worktreeDir, setupOpts({ repair: true, dryRun: true, json: true }));

    expect(mockEnsureDockerServices).not.toHaveBeenCalled();
    expect(mockWriteRegistry).not.toHaveBeenCalled();
    expect(mockCopyAndPatchAllEnvFiles).not.toHaveBeenCalled();

    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      data: { repaired: boolean; dryRun: boolean; portChanges: unknown[] };
    };
    expect(payload.data.repaired).toBe(true);
    expect(payload.data.dryRun).toBe(true);
    expect(payload.data.portChanges).toHaveLength(1);
  });

  it('--repair on a fresh worktree errors out', async () => {
    mockFindByPath.mockReturnValue(null);

    await setupCommand(worktreeDir, setupOpts({ repair: true, json: true }));

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean; error: { code: string };
    };
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('NO_ALLOCATION');
  });

  it('--dry-run without --repair errors out', async () => {
    await setupCommand(worktreeDir, setupOpts({ dryRun: true, json: true }));

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean; error: { code: string };
    };
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('INVALID_OPTIONS');
  });

  it('--repair with no port or compose changes is idempotent and does not write', async () => {
    const allocation: Allocation = {
      worktreePath: worktreeDir,
      branchName: 'feat/auth',
      dbName: 'myapp_wt2',
      docker: { projectName: 'wt-2-myapp', services: [], serviceHashes: {} },
      ports: { web: 3200 },
      createdAt: '2026-04-25T00:00:00.000Z',
    };
    mockFindByPath.mockReturnValue([2, allocation]);
    mockAllocateServicePorts.mockResolvedValue({ ports: { web: 3200 }, drifts: [] });
    mockComputeServiceHashes.mockReturnValue({});
    mockEnsureDockerServices.mockReturnValue({ projectName: 'wt-2-myapp', services: [], serviceHashes: {} });

    await setupCommand(worktreeDir, setupOpts({ repair: true, json: true }));

    expect(mockEnsureDockerServices).not.toHaveBeenCalled();
    expect(mockWriteRegistry).not.toHaveBeenCalled();
    expect(mockCopyAndPatchAllEnvFiles).not.toHaveBeenCalled();

    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      data: { repaired: boolean; portChanges: Array<{ reason: string }> };
    };
    expect(payload.data.repaired).toBe(true);
    expect(payload.data.portChanges.every((c) => c.reason === 'unchanged')).toBe(true);
  });
```

- [ ] **Step 8: Run setup tests**

Run: `pnpm test -- setup.spec`
Expected: all new and existing setup tests pass.

- [ ] **Step 9: Run full suite + tsc + lint**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm lint`
Expected: green.

- [ ] **Step 10: Commit**

```bash
git add src/cli.ts src/commands/setup.ts src/commands/setup.spec.ts
git commit -m "feat(setup): --repair and --dry-run flags"
```

---

## Task 9: README and SKILL.md Updates

**Files:**
- Modify: `README.md`
- Modify: `skills/wt/SKILL.md`

- [ ] **Step 1: Update the `wt setup` command section in README.md**

Find the `### \`wt setup …\`` heading in `README.md`. Replace its signature line and the lead paragraph so they look like the heading and intro shown below. Then append the two new subsections (`--repair` and `--dry-run`) after the existing description.

**New signature heading:**

`### \`wt setup [path] [--no-install] [--json] [--repair] [--dry-run]\``

**Replacement lead paragraph (immediately after the heading):**

> Sets up an existing worktree that was created manually or by another tool. Useful when:
>
> - You ran `git worktree add` directly
> - A worktree's env files need regenerating
> - Called automatically by the `post-checkout` hook
> - A worktree's port allocation has gone stale (use `--repair`)
>
> If the worktree already has a slot allocation, it reuses it. `wt setup` is idempotent for Docker: services whose compose-config hash hasn't changed are left running; only services with a config change (or a port change in `--repair` mode) are stopped and recreated. The first `wt setup` after upgrading to this version stores the current hashes as a baseline without recreating anything.

**Append after the existing setup description:**

> #### `--repair`
>
> Re-allocates ports for an existing worktree as if creating it fresh now. Useful when:
>
> - An external process has seized one of the worktree's ports.
> - The allocation predates port-drift (v0.4.1) and needs refreshing.
> - An adjacent slot was removed, freeing a port the worktree had drifted around.
>
> Repair re-runs `allocateServicePorts` excluding the slot's own current ports from the reserved set, then writes the new allocation, re-renders env files, and recreates only the docker services whose ports (or compose config) actually changed. `wt remove` is intentionally not the answer to a stale port allocation — it would delete the worktree directory and any uncommitted work. Repair preserves the worktree directory, the database, and untouched ports.
>
> #### `--dry-run`
>
> Used with `--repair`, prints the proposed reallocation and exits without writing anything. The output looks like:
>
> ```
> Repair preview for slot 20 (cryptoacc_wt20):
>   app             5000 → 5005   in use by python3[12345]
>   server          5001 (unchanged)
>   redis           8379 (unchanged)
>
> Docker services to recreate: redis
>
> [dry-run] No changes written. Re-run without --dry-run to apply.
> ```
>
> `--dry-run` requires `--repair`; using it alone errors out.

(The blockquoted prose above is the literal text to paste into README.md — strip the leading `> ` markers when writing the file. The fenced ` ``` ` block inside is plain triple-backticks in the README itself.)

- [ ] **Step 2: Update `skills/wt/SKILL.md`**

Read `skills/wt/SKILL.md` first. The skill is a structured guide for Claude Code. Find the section that lists `wt setup` and add a brief paragraph (under whichever heading hosts the existing setup mention):

```markdown
- `wt setup --repair` — re-allocate ports for an existing worktree (e.g. when one of its ports has been seized by another process). Use when `wt list` or `wt doctor` reports stale allocations and you want to keep the worktree directory intact (do NOT use `wt remove` for this — it deletes the worktree directory and uncommitted work).
- `wt setup --repair --dry-run` — preview the reallocation without applying.
```

Place this near the existing `wt setup` documentation in the skill.

- [ ] **Step 3: Verify there are no syntax issues in the README**

Run: `pnpm lint`
Expected: clean (lint covers TS only; the README change is verified by visual inspection).

Open `README.md` in the editor and visually confirm:
- The new flags appear in the signature heading.
- The `--repair` and `--dry-run` subsections are formatted consistently with surrounding sections.

- [ ] **Step 4: Commit**

```bash
git add README.md skills/wt/SKILL.md
git commit -m "docs: --repair and --dry-run for wt setup"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: all tests pass; one pre-existing skipped suite (`docker-services.docker.spec.ts` behind `WT_RUN_DOCKER_TESTS`).

- [ ] **Step 3: Run tsc**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Run build**

Run: `pnpm build`
Expected: dist/ produced; CLI linked.

- [ ] **Step 5: Smoke test (optional, requires a downstream consumer with `wt.config.json`)**

In a real downstream repo:

```
# 1. Confirm idempotent re-run on a healthy worktree
cd /path/to/your-app
wt setup --no-install
wt setup --no-install     # second run should be a no-op (no docker recreation, no errors)

# 2. Confirm --dry-run preview
wt setup --repair --dry-run

# 3. If preview shows expected changes, apply
wt setup --repair --no-install

# 4. Bad combination
wt setup --dry-run         # should print: --dry-run requires --repair.
```

(Skip this step if there's no downstream consumer handy. CI plus the unit tests cover the wiring.)

- [ ] **Step 6: Commit any final tweaks (if step 5 surfaced any)**

```bash
git status
# If clean, no commit needed.
```
