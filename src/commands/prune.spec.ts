import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('../core/registry', () => ({
  readRegistry: jest.fn(),
  writeRegistry: jest.fn(),
  removeAllocation: jest.fn(),
  findByPath: jest.fn(),
}));

jest.mock('../core/database', () => ({
  dropDatabase: jest.fn(),
}));

jest.mock('../core/git', () => ({
  getMainWorktreePath: jest.fn(),
  listPrunableWorktrees: jest.fn(),
  pruneWorktrees: jest.fn(),
}));

jest.mock('../core/managed-redis', () => ({
  removeManagedRedisContainer: jest.fn(),
}));

jest.mock('./setup', () => ({
  loadConfig: jest.fn(),
}));

import { readRegistry, writeRegistry, removeAllocation, findByPath } from '../core/registry';
import { dropDatabase } from '../core/database';
import { getMainWorktreePath, listPrunableWorktrees, pruneWorktrees } from '../core/git';
import { removeManagedRedisContainer } from '../core/managed-redis';
import { loadConfig } from './setup';
import { pruneCommand } from './prune';
import type { Allocation, Registry, WtConfig } from '../types';

const mockReadRegistry = readRegistry as jest.MockedFunction<typeof readRegistry>;
const mockWriteRegistry = writeRegistry as jest.MockedFunction<typeof writeRegistry>;
const mockRemoveAllocation = removeAllocation as jest.MockedFunction<typeof removeAllocation>;
const mockFindByPath = findByPath as jest.MockedFunction<typeof findByPath>;
const mockDropDatabase = dropDatabase as jest.MockedFunction<typeof dropDatabase>;
const mockGetMainWorktreePath = getMainWorktreePath as jest.MockedFunction<typeof getMainWorktreePath>;
const mockListPrunableWorktrees = listPrunableWorktrees as jest.MockedFunction<typeof listPrunableWorktrees>;
const mockPruneWorktrees = pruneWorktrees as jest.MockedFunction<typeof pruneWorktrees>;
const mockRemoveManagedRedisContainer = removeManagedRedisContainer as jest.MockedFunction<
  typeof removeManagedRedisContainer
>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

describe('pruneCommand', () => {
  let tmpDir: string;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  const allocation: Allocation = {
    worktreePath: '/repo/.worktrees/feat-auth',
    branchName: 'feat/auth',
    dbName: 'myapp_wt2',
    redisContainerName: 'wt-myapp-deadbeef-slot-2-redis',
    ports: { web: 3200, redis: 6579 },
    createdAt: '2026-03-08T00:00:00.000Z',
  };

  const config: WtConfig = {
    baseDatabaseName: 'myapp',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 50,
    services: [
      { name: 'web', defaultPort: 3000 },
      { name: 'redis', defaultPort: 6379 },
    ],
    envFiles: [],
    postSetup: [],
    autoInstall: true,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-prune-test-'));
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp\n',
      'utf-8',
    );

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockGetMainWorktreePath.mockReturnValue(tmpDir);
    mockReadRegistry.mockReturnValue({
      version: 1,
      allocations: {
        '2': allocation,
      },
    } satisfies Registry);
    mockFindByPath.mockImplementation((_registry, worktreePath) => {
      return path.resolve(worktreePath) === path.resolve(allocation.worktreePath)
        ? [2, allocation]
        : null;
    });
    mockRemoveAllocation.mockImplementation((registry) => ({
      ...registry,
      allocations: {},
    }));
    mockRemoveManagedRedisContainer.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(config);
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('reports managed and unmanaged prunable worktrees in dry-run mode', async () => {
    mockListPrunableWorktrees.mockReturnValue([
      { path: allocation.worktreePath, reason: 'gitdir file points to non-existent location' },
      { path: '/repo/.worktrees/unmanaged', reason: 'gitdir file points to non-existent location' },
    ]);

    await pruneCommand({ json: true, keepDb: false, dryRun: true });

    expect(mockDropDatabase).not.toHaveBeenCalled();
    expect(mockPruneWorktrees).not.toHaveBeenCalled();
    expect(mockWriteRegistry).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: {
        prunableCount: number;
        managed: Array<{ slot: number }>;
        unmanaged: Array<{ worktreePath: string }>;
      };
    };
    expect(output.success).toBe(true);
    expect(output.data.prunableCount).toBe(2);
    expect(output.data.managed).toHaveLength(1);
    expect(output.data.managed[0]?.slot).toBe(2);
    expect(output.data.unmanaged).toEqual([
      { worktreePath: '/repo/.worktrees/unmanaged', reason: 'gitdir file points to non-existent location' },
    ]);
  });

  it('drops managed resources and prunes Git metadata', async () => {
    mockListPrunableWorktrees.mockReturnValue([
      { path: allocation.worktreePath, reason: 'gitdir file points to non-existent location' },
      { path: '/repo/.worktrees/unmanaged', reason: 'gitdir file points to non-existent location' },
    ]);

    await pruneCommand({ json: true, keepDb: false, dryRun: false });

    expect(mockLoadConfig).toHaveBeenCalledWith(tmpDir);
    expect(mockDropDatabase).toHaveBeenCalledWith(
      'postgresql://user:pw@localhost:5432/myapp',
      allocation.dbName,
      'myapp',
      expect.any(Function),
    );
    expect(mockRemoveManagedRedisContainer).toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
    expect(mockRemoveAllocation).toHaveBeenCalled();
    expect(mockWriteRegistry).toHaveBeenCalledWith(tmpDir, { version: 1, allocations: {} });
    expect(mockPruneWorktrees).toHaveBeenCalledWith(expect.any(Function));

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: {
        prunedManaged: Array<{ slot: number; redisContainerRemoved: boolean }>;
        prunedUnmanaged: Array<{ worktreePath: string }>;
        failed: unknown[];
      };
    };
    expect(output.success).toBe(true);
    expect(output.data.prunedManaged).toHaveLength(1);
    expect(output.data.prunedManaged[0]?.slot).toBe(2);
    expect(output.data.prunedManaged[0]?.redisContainerRemoved).toBe(true);
    expect(output.data.prunedUnmanaged).toEqual([
      { worktreePath: '/repo/.worktrees/unmanaged', reason: 'gitdir file points to non-existent location' },
    ]);
    expect(output.data.failed).toEqual([]);
  });
});
