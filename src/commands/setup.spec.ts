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
  buildDockerComposeConfig: jest.fn(),
  computeServiceHashes: jest.fn(),
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
import {
  ensureDockerServices,
  buildDockerComposeConfig,
  computeServiceHashes,
} from '../core/docker-services';
import { getMainWorktreePath, isMainWorktree, getBranchName } from '../core/git';
import { setupCommand } from './setup';
import type { Allocation, WtConfig } from '../types';

function setupOpts(overrides: Partial<{ json: boolean; install: boolean; repair: boolean; dryRun: boolean }> = {}): {
  json: boolean;
  install: boolean;
  repair: boolean;
  dryRun: boolean;
} {
  return { json: false, install: false, repair: false, dryRun: false, ...overrides };
}

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
const mockBuildDockerComposeConfig = buildDockerComposeConfig as jest.MockedFunction<
  typeof buildDockerComposeConfig
>;
const mockComputeServiceHashes = computeServiceHashes as jest.MockedFunction<
  typeof computeServiceHashes
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
    mockBuildDockerComposeConfig.mockReturnValue({ services: {} });
    mockComputeServiceHashes.mockReturnValue({});
    mockEnsureDockerServices.mockReturnValue({ projectName: 'wt-2-myapp', services: [], serviceHashes: {} });
    mockAddAllocation.mockImplementation((registry, slot, allocation) => ({
      ...registry,
      allocations: { ...registry.allocations, [String(slot)]: allocation },
    }));
    mockWriteRegistry.mockImplementation(() => {});
    mockCopyAndPatchAllEnvFiles.mockImplementation(() => {});
    mockAllocateServicePorts.mockResolvedValue({ ports: { web: 3200 }, drifts: [] });
    process.exitCode = 0;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('logs drift to stderr in human mode for fresh allocation', async () => {
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

    await setupCommand(worktreeDir, setupOpts({ json: false, install: false }));

    const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stderr).toContain(
      'Port 3200 (web) in use by node[12345]; using 3201 instead.',
    );
  });

  it('suppresses drift stderr in JSON mode but includes portDrifts in payload', async () => {
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

    await setupCommand(worktreeDir, setupOpts({ json: true, install: false }));

    const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stderr).not.toContain('Port 3200');

    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: { portDrifts: unknown[]; ports: Record<string, number> };
    };
    expect(payload.success).toBe(true);
    expect(payload.data.ports).toEqual({ web: 3201 });
    expect(payload.data.portDrifts).toHaveLength(1);
  });

  it('reuses registered ports verbatim for an existing allocation (no re-allocation)', async () => {
    const allocation: Allocation = {
      worktreePath: worktreeDir,
      branchName: 'feat/auth',
      dbName: 'myapp_wt2',
      ports: { web: 3207 }, // drifted in a previous run
      createdAt: '2026-04-25T00:00:00.000Z',
    };
    mockFindByPath.mockReturnValue([2, allocation]);

    await setupCommand(worktreeDir, setupOpts({ json: true, install: false }));

    expect(mockAllocateServicePorts).not.toHaveBeenCalled();
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

    await setupCommand(worktreeDir, setupOpts({ json: true, install: false }));

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

    await setupCommand(worktreeDir, setupOpts({ json: true, install: false }));

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
});
