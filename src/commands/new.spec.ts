import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('../core/registry', () => ({
  readRegistry: jest.fn(),
  writeRegistry: jest.fn(),
  addAllocation: jest.fn(),
}));

jest.mock('../core/slot-allocator', () => ({
  calculatePorts: jest.fn(),
  calculateDbName: jest.fn(),
  findAvailablePortSafeSlot: jest.fn(),
  findUnavailableServicePorts: jest.fn(),
}));

jest.mock('../core/env-patcher', () => ({
  copyAndPatchAllEnvFiles: jest.fn(),
}));

jest.mock('../core/database', () => ({
  createDatabase: jest.fn(),
  databaseExists: jest.fn(),
  dropDatabase: jest.fn(),
}));

jest.mock('../core/docker-services', () => ({
  ensureDockerServices: jest.fn(),
  removeDockerServices: jest.fn(),
}));

jest.mock('../core/git', () => ({
  getMainWorktreePath: jest.fn(),
  createWorktree: jest.fn(),
  getBranchName: jest.fn(),
  removeWorktree: jest.fn(),
  resolveWorktreeBranch: jest.fn(),
}));

jest.mock('./setup', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

import { addAllocation, readRegistry, writeRegistry } from '../core/registry';
import {
  calculatePorts,
  calculateDbName,
  findAvailablePortSafeSlot,
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
const mockCalculatePorts = calculatePorts as jest.MockedFunction<typeof calculatePorts>;
const mockCalculateDbName = calculateDbName as jest.MockedFunction<typeof calculateDbName>;
const mockFindAvailablePortSafeSlot = findAvailablePortSafeSlot as jest.MockedFunction<
  typeof findAvailablePortSafeSlot
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

describe('new command branch selection', () => {
  let tmpDir: string;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

  const config: WtConfig = {
    baseDatabaseName: 'myapp',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 50,
    services: [
      { name: 'web', defaultPort: 3000 },
    ],
    dockerServices: [],
    envFiles: [],
    postSetup: [],
    autoInstall: true,
  };

  const allocation: Allocation = {
    worktreePath: '/repo/.worktrees/feat-auth',
    branchName: 'feat/auth',
    dbName: 'myapp_wt2',
    ports: { web: 3200 },
    createdAt: '2026-03-24T00:00:00.000Z',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-new-test-'));
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp\n',
      'utf-8',
    );

    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    mockGetMainWorktreePath.mockReturnValue(tmpDir);
    mockLoadConfig.mockReturnValue(config);
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);
    mockFindAvailablePortSafeSlot.mockResolvedValue(2);
    mockCalculatePorts.mockReturnValue({ web: 3200 });
    mockCalculateDbName.mockReturnValue('myapp_wt2');
    mockDatabaseExists.mockResolvedValue(false);
    mockCreateDatabase.mockResolvedValue();
    mockCreateWorktree.mockReturnValue(allocation.worktreePath);
    mockGetBranchName.mockReturnValue(allocation.branchName);
    mockAddAllocation.mockReturnValue({
      version: 1,
      allocations: {
        '2': allocation,
      },
    } satisfies Registry);
    process.exitCode = 0;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('logs when the worktree will track a branch from origin', async () => {
    mockResolveWorktreeBranch.mockReturnValue(originSelection());

    const result = await createNewWorktree('feat/auth', { install: false });

    expect(result.branchSelection).toEqual(originSelection());
    expect(mockResolveWorktreeBranch).toHaveBeenCalledWith('feat/auth', expect.any(Function));
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      path.join(tmpDir, config.baseWorktreePath),
      originSelection(),
      expect.any(Function),
    );
    expect(stderrOutput(stderrSpy)).toContain("Using branch 'feat/auth' from origin/feat/auth.");
    expect(mockWriteRegistry).toHaveBeenCalledWith(tmpDir, {
      version: 1,
      allocations: {
        '2': allocation,
      },
    });
    expect(mockCopyAndPatchAllEnvFiles).toHaveBeenCalled();
  });

  it('warns and falls back to a fresh local branch when origin lookup fails', async () => {
    const branchSelection: WorktreeBranchSelection = {
      branchName: 'feat/auth',
      source: 'local-new',
      sourceLabel: 'fresh local branch',
      originCheckError: 'fatal: Could not resolve host: github.com',
    };
    mockResolveWorktreeBranch.mockReturnValue(branchSelection);

    const result = await createNewWorktree('feat/auth', { install: false, quiet: true });

    expect(result.branchSelection).toEqual(branchSelection);
    expect(stderrOutput(stderrSpy)).toContain(
      "Failed to check origin for 'feat/auth': fatal: Could not resolve host: github.com",
    );
  });

  it('includes branch source details in json output', async () => {
    mockResolveWorktreeBranch.mockReturnValue(originSelection());

    await newCommand('feat/auth', {
      json: true,
      install: false,
    });

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: {
        slot: number;
        branchName: string;
        branchSource: string;
        branchSourceLabel: string;
      };
    };

    expect(output.success).toBe(true);
    expect(output.data.slot).toBe(2);
    expect(output.data.branchName).toBe('feat/auth');
    expect(output.data.branchSource).toBe('origin');
    expect(output.data.branchSourceLabel).toBe('origin/feat/auth');
  });

  it('includes branch source details in human summary output', async () => {
    mockResolveWorktreeBranch.mockReturnValue(originSelection());

    await newCommand('feat/auth', {
      json: false,
      install: false,
    });

    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('Source:   origin/feat/auth');
  });
});

describe('new command rollback on failure', () => {
  let tmpDir: string;
  let worktreeDir: string;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

  const configWithDocker: WtConfig = {
    baseDatabaseName: 'myapp',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 50,
    services: [
      { name: 'web', defaultPort: 3000 },
      { name: 'redis', defaultPort: 6379 },
    ],
    envFiles: [
      {
        source: '.env',
        patches: [{ var: 'REDIS_URL', type: 'url', service: 'redis' }],
      },
    ],
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
    postSetup: [],
    autoInstall: true,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-new-rollback-'));
    // Point the worktree mock at a real directory so the rollback's
    // fs.existsSync check actually exercises removeWorktree.
    worktreeDir = path.join(tmpDir, '.worktrees', 'feat-auth');
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp\n',
      'utf-8',
    );

    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(console, 'log').mockImplementation(() => {});

    mockGetMainWorktreePath.mockReturnValue(tmpDir);
    mockLoadConfig.mockReturnValue(configWithDocker);
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);
    mockFindAvailablePortSafeSlot.mockResolvedValue(2);
    mockCalculatePorts.mockReturnValue({ web: 3200, redis: 6579 });
    mockCalculateDbName.mockReturnValue('myapp_wt2');
    mockEnsureDockerServices.mockReturnValue({
      projectName: 'wt-myapp-deadbeef-slot-2',
      services: ['redis'],
    });
    mockRemoveDockerServices.mockReturnValue(true);
    mockDatabaseExists.mockResolvedValue(false);
    mockCreateDatabase.mockResolvedValue();
    mockDropDatabase.mockResolvedValue();
    mockCreateWorktree.mockReturnValue(worktreeDir);
    mockGetBranchName.mockReturnValue('feat/auth');
    mockResolveWorktreeBranch.mockReturnValue({
      branchName: 'feat/auth',
      source: 'local-new',
      sourceLabel: 'fresh local branch',
    });
    process.exitCode = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('starts Docker after database creation', async () => {
    await createNewWorktree('feat/auth', { install: false, quiet: true });

    const createOrder = mockCreateDatabase.mock.invocationCallOrder[0];
    const dockerOrder = mockEnsureDockerServices.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(dockerOrder!);
    expect(mockEnsureDockerServices).toHaveBeenCalledWith({
      mainRoot: tmpDir,
      slot: 2,
      branchName: 'feat/auth',
      worktreePath: worktreeDir,
      dbName: 'myapp_wt2',
      ports: { web: 3200, redis: 6579 },
      config: configWithDocker,
      log: expect.any(Function),
    });
  });

  it('rolls back Docker, database, and worktree when env patching fails', async () => {
    const boom = new Error('env patch exploded');
    mockCopyAndPatchAllEnvFiles.mockImplementation(() => {
      throw boom;
    });

    await expect(createNewWorktree('feat/auth', { install: false, quiet: true })).rejects.toBe(boom);

    expect(mockDropDatabase).toHaveBeenCalledWith(
      'postgresql://user:pw@localhost:5432/myapp',
      'myapp_wt2',
      'myapp',
      expect.any(Function),
    );
    expect(mockRemoveDockerServices).toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
    expect(mockRemoveWorktree).toHaveBeenCalledWith(worktreeDir, expect.any(Function));
    expect(mockWriteRegistry).not.toHaveBeenCalled();
  });

  it('does not drop a pre-existing database during rollback', async () => {
    mockDatabaseExists.mockResolvedValue(true);
    const boom = new Error('env patch exploded');
    mockCopyAndPatchAllEnvFiles.mockImplementation(() => {
      throw boom;
    });

    await expect(createNewWorktree('feat/auth', { install: false, quiet: true })).rejects.toBe(boom);

    // We reused an existing DB, so we must not drop it on rollback.
    expect(mockDropDatabase).not.toHaveBeenCalled();
    expect(mockRemoveDockerServices).toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
    expect(mockRemoveWorktree).toHaveBeenCalled();
  });

  it('does not start Docker when createDatabase fails', async () => {
    const boom = new Error('CREATE DATABASE failed');
    mockCreateDatabase.mockRejectedValue(boom);

    await expect(createNewWorktree('feat/auth', { install: false, quiet: true })).rejects.toBe(boom);

    // DB creation failed before completion so no drop needed.
    expect(mockDropDatabase).not.toHaveBeenCalled();
    expect(mockEnsureDockerServices).not.toHaveBeenCalled();
    expect(mockRemoveDockerServices).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).toHaveBeenCalled();
    expect(mockWriteRegistry).not.toHaveBeenCalled();
  });

  it('propagates the original error even if rollback steps themselves fail', async () => {
    const originalError = new Error('env patch exploded');
    mockCopyAndPatchAllEnvFiles.mockImplementation(() => {
      throw originalError;
    });
    mockDropDatabase.mockRejectedValue(new Error('postgres unreachable'));
    mockRemoveDockerServices.mockImplementation(() => {
      throw new Error('docker daemon down');
    });
    mockRemoveWorktree.mockImplementation(() => {
      throw new Error('git refused');
    });

    await expect(createNewWorktree('feat/auth', { install: false, quiet: true })).rejects.toBe(originalError);

    const stderr = stderrOutput(stderrSpy);
    expect(stderr).toContain('Rolling back partial setup');
    expect(stderr).toContain('postgres unreachable');
    expect(stderr).toContain('docker daemon down');
    expect(stderr).toContain('git refused');
  });

  it('skips Docker rollback when no docker services are configured', async () => {
    mockLoadConfig.mockReturnValue({ ...configWithDocker, dockerServices: [] });
    const boom = new Error('env patch exploded');
    mockCopyAndPatchAllEnvFiles.mockImplementation(() => {
      throw boom;
    });

    await expect(createNewWorktree('feat/auth', { install: false, quiet: true })).rejects.toBe(boom);

    expect(mockEnsureDockerServices).toHaveBeenCalled();
    expect(mockRemoveDockerServices).not.toHaveBeenCalled();
    expect(mockRemoveWorktree).toHaveBeenCalled();
  });
});

function originSelection(): WorktreeBranchSelection {
  return {
    branchName: 'feat/auth',
    source: 'origin',
    sourceLabel: 'origin/feat/auth',
    startPoint: 'origin/feat/auth',
  };
}

function stderrOutput(
  stderrSpy: jest.SpiedFunction<typeof process.stderr.write>,
): string {
  return stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
}
