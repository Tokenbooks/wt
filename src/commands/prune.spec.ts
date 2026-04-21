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
  listManagedRedisContainersForRepo: jest.fn(),
  usesManagedRedis: jest.fn(),
}));

jest.mock('./setup', () => ({
  loadConfig: jest.fn(),
}));

import { readRegistry, writeRegistry, removeAllocation, findByPath } from '../core/registry';
import { dropDatabase } from '../core/database';
import { getMainWorktreePath, listPrunableWorktrees, pruneWorktrees } from '../core/git';
import {
  removeManagedRedisContainer,
  listManagedRedisContainersForRepo,
  usesManagedRedis,
} from '../core/managed-redis';
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
const mockListManagedRedisContainersForRepo =
  listManagedRedisContainersForRepo as jest.MockedFunction<typeof listManagedRedisContainersForRepo>;
const mockUsesManagedRedis = usesManagedRedis as jest.MockedFunction<typeof usesManagedRedis>;
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
    mockListManagedRedisContainersForRepo.mockReturnValue([]);
    mockUsesManagedRedis.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(config);
    mockListPrunableWorktrees.mockReturnValue([]);
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
        orphanContainers: Array<{ containerName: string }>;
      };
    };
    expect(output.success).toBe(true);
    expect(output.data.prunableCount).toBe(2);
    expect(output.data.managed).toHaveLength(1);
    expect(output.data.managed[0]?.slot).toBe(2);
    expect(output.data.unmanaged).toEqual([
      { worktreePath: '/repo/.worktrees/unmanaged', reason: 'gitdir file points to non-existent location' },
    ]);
    expect(output.data.orphanContainers).toEqual([]);
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
        prunedOrphanContainers: unknown[];
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
    expect(output.data.prunedOrphanContainers).toEqual([]);
    expect(output.data.failed).toEqual([]);
  });

  it('prunes registry entries whose worktree path does not exist on disk', async () => {
    // Registry has slot 2 pointing to a path that doesn't exist. Git knows nothing
    // about it (listPrunableWorktrees returns []), so this only surfaces via the
    // filesystem-existence check.
    mockListPrunableWorktrees.mockReturnValue([]);

    await pruneCommand({ json: true, keepDb: false, dryRun: false });

    expect(mockDropDatabase).toHaveBeenCalledWith(
      'postgresql://user:pw@localhost:5432/myapp',
      allocation.dbName,
      'myapp',
      expect.any(Function),
    );
    expect(mockRemoveManagedRedisContainer).toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
    expect(mockRemoveAllocation).toHaveBeenCalled();
    expect(mockWriteRegistry).toHaveBeenCalled();
    // No Git-prunable entries, so `git worktree prune` must not run.
    expect(mockPruneWorktrees).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: {
        prunedManaged: Array<{ slot: number; reasonSource: string }>;
      };
    };
    expect(output.data.prunedManaged).toHaveLength(1);
    expect(output.data.prunedManaged[0]?.reasonSource).toBe('missing-path');
  });

  it('does not double-prune a registry entry that is both git-prunable and missing on disk', async () => {
    mockListPrunableWorktrees.mockReturnValue([
      { path: allocation.worktreePath, reason: 'gitdir file points to non-existent location' },
    ]);

    await pruneCommand({ json: true, keepDb: false, dryRun: false });

    expect(mockDropDatabase).toHaveBeenCalledTimes(1);
    expect(mockRemoveManagedRedisContainer).toHaveBeenCalledTimes(1);
    expect(mockRemoveAllocation).toHaveBeenCalledTimes(1);

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      data: {
        prunedManaged: Array<{ slot: number; reasonSource: string }>;
      };
    };
    expect(output.data.prunedManaged).toHaveLength(1);
    // The git-prunable check runs first, so the reason source is 'git'.
    expect(output.data.prunedManaged[0]?.reasonSource).toBe('git');
  });

  it('removes orphan Redis containers whose slot is not in the registry', async () => {
    mockListManagedRedisContainersForRepo.mockReturnValue([
      // slot 2 matches the live registry entry — NOT an orphan.
      { containerName: 'wt-myapp-deadbeef-slot-2-redis', slot: 2, branch: 'feat/auth' },
      // slot 7 has no registry entry — orphan.
      {
        containerName: 'wt-myapp-deadbeef-slot-7-redis',
        slot: 7,
        branch: 'fix/old',
        worktreePath: '/repo/.worktrees/fix-old',
      },
      // slot 9 has no registry entry — orphan.
      { containerName: 'wt-myapp-deadbeef-slot-9-redis', slot: 9 },
    ]);
    // Registry entry for slot 2 points to an existing dir so it stays put.
    const livePath = path.join(tmpDir, 'live-worktree');
    fs.mkdirSync(livePath);
    mockReadRegistry.mockReturnValue({
      version: 1,
      allocations: {
        '2': { ...allocation, worktreePath: livePath },
      },
    } satisfies Registry);

    await pruneCommand({ json: true, keepDb: false, dryRun: false });

    // Registry slot 2 should remain — we must not touch its container.
    expect(mockRemoveManagedRedisContainer).not.toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
    expect(mockRemoveManagedRedisContainer).toHaveBeenCalledWith(tmpDir, 7, expect.any(Function));
    expect(mockRemoveManagedRedisContainer).toHaveBeenCalledWith(tmpDir, 9, expect.any(Function));
    expect(mockWriteRegistry).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      data: {
        prunedManaged: unknown[];
        prunedOrphanContainers: Array<{ slot: number; containerName: string; removed: boolean }>;
      };
    };
    expect(output.data.prunedManaged).toEqual([]);
    expect(output.data.prunedOrphanContainers).toHaveLength(2);
    expect(output.data.prunedOrphanContainers.map((o) => o.slot).sort()).toEqual([7, 9]);
    expect(output.data.prunedOrphanContainers.every((o) => o.removed)).toBe(true);
  });

  it('reports orphan Redis containers in dry-run without touching Docker', async () => {
    mockListManagedRedisContainersForRepo.mockReturnValue([
      { containerName: 'wt-myapp-deadbeef-slot-9-redis', slot: 9 },
    ]);
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);

    await pruneCommand({ json: true, keepDb: false, dryRun: true });

    expect(mockRemoveManagedRedisContainer).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      data: { orphanContainers: Array<{ slot: number }> };
    };
    expect(output.data.orphanContainers).toHaveLength(1);
    expect(output.data.orphanContainers[0]?.slot).toBe(9);
  });

  it('does not scan Docker when managed Redis is disabled for the repo', async () => {
    mockUsesManagedRedis.mockReturnValue(false);
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);

    await pruneCommand({ json: true, keepDb: false, dryRun: true });

    expect(mockListManagedRedisContainersForRepo).not.toHaveBeenCalled();
  });

  it('reports nothing-to-prune cleanly when registry is empty and no orphans exist', async () => {
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);

    await pruneCommand({ json: true, keepDb: false, dryRun: false });

    expect(mockDropDatabase).not.toHaveBeenCalled();
    expect(mockRemoveManagedRedisContainer).not.toHaveBeenCalled();
    expect(mockWriteRegistry).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: {
        prunedManaged: unknown[];
        prunedUnmanaged: unknown[];
        prunedOrphanContainers: unknown[];
        failed: unknown[];
      };
    };
    expect(output.success).toBe(true);
    expect(output.data.prunedManaged).toEqual([]);
    expect(output.data.prunedOrphanContainers).toEqual([]);
  });
});
