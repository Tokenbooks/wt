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

jest.mock('../core/docker-services', () => ({
  removeDockerServices: jest.fn(),
  listManagedDockerProjectsForRepo: jest.fn(),
  usesDockerServices: jest.fn(),
}));

jest.mock('./setup', () => ({
  loadConfig: jest.fn(),
}));

import { readRegistry, writeRegistry, removeAllocation, findByPath } from '../core/registry';
import { dropDatabase } from '../core/database';
import { getMainWorktreePath, listPrunableWorktrees, pruneWorktrees } from '../core/git';
import {
  removeDockerServices,
  listManagedDockerProjectsForRepo,
  usesDockerServices,
} from '../core/docker-services';
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
const mockRemoveDockerServices = removeDockerServices as jest.MockedFunction<
  typeof removeDockerServices
>;
const mockListManagedDockerProjectsForRepo =
  listManagedDockerProjectsForRepo as jest.MockedFunction<typeof listManagedDockerProjectsForRepo>;
const mockUsesDockerServices = usesDockerServices as jest.MockedFunction<typeof usesDockerServices>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

describe('pruneCommand', () => {
  let tmpDir: string;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  const allocation: Allocation = {
    worktreePath: '/repo/.worktrees/feat-auth',
    branchName: 'feat/auth',
    dbName: 'myapp_wt2',
    docker: {
      projectName: 'wt-2-myapp-deadbeef',
      services: ['redis'],
    },
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
    dockerServices: [
      {
        name: 'redis',
        image: 'redis:8-alpine',
        restart: 'unless-stopped',
        ports: [{ service: 'redis', target: 6379, host: '127.0.0.1' }],
        environment: {},
        volumes: [],
        extraHosts: [],
      },
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
    mockRemoveDockerServices.mockReturnValue(true);
    mockListManagedDockerProjectsForRepo.mockReturnValue([]);
    mockUsesDockerServices.mockReturnValue(true);
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
        orphanDockerProjects: Array<{ projectName: string }>;
      };
    };
    expect(output.success).toBe(true);
    expect(output.data.prunableCount).toBe(2);
    expect(output.data.managed).toHaveLength(1);
    expect(output.data.managed[0]?.slot).toBe(2);
    expect(output.data.unmanaged).toEqual([
      { worktreePath: '/repo/.worktrees/unmanaged', reason: 'gitdir file points to non-existent location' },
    ]);
    expect(output.data.orphanDockerProjects).toEqual([]);
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
    expect(mockRemoveDockerServices).toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
    expect(mockRemoveAllocation).toHaveBeenCalled();
    expect(mockWriteRegistry).toHaveBeenCalledWith(tmpDir, { version: 1, allocations: {} });
    expect(mockPruneWorktrees).toHaveBeenCalledWith(expect.any(Function));

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: {
        prunedManaged: Array<{ slot: number; dockerRemoved: boolean }>;
        prunedUnmanaged: Array<{ worktreePath: string }>;
        prunedOrphanDockerProjects: unknown[];
        failed: unknown[];
      };
    };
    expect(output.success).toBe(true);
    expect(output.data.prunedManaged).toHaveLength(1);
    expect(output.data.prunedManaged[0]?.slot).toBe(2);
    expect(output.data.prunedManaged[0]?.dockerRemoved).toBe(true);
    expect(output.data.prunedUnmanaged).toEqual([
      { worktreePath: '/repo/.worktrees/unmanaged', reason: 'gitdir file points to non-existent location' },
    ]);
    expect(output.data.prunedOrphanDockerProjects).toEqual([]);
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
    expect(mockRemoveDockerServices).toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
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
    expect(mockRemoveDockerServices).toHaveBeenCalledTimes(1);
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

  it('removes orphan Docker projects whose slot is not in the registry', async () => {
    mockListManagedDockerProjectsForRepo.mockReturnValue([
      // slot 2 matches the live registry entry — NOT an orphan.
      {
        projectName: 'wt-2-myapp-deadbeef',
        slot: 2,
        branch: 'feat/auth',
        services: ['redis'],
        containerNames: ['wt-2-myapp-deadbeef-redis'],
      },
      // slot 7 has no registry entry — orphan.
      {
        projectName: 'wt-7-myapp-deadbeef',
        slot: 7,
        branch: 'fix/old',
        worktreePath: '/repo/.worktrees/fix-old',
        services: ['redis', 'electric'],
        containerNames: ['wt-7-myapp-deadbeef-redis', 'wt-7-myapp-deadbeef-electric'],
      },
      // slot 9 has no registry entry — orphan.
      {
        projectName: 'wt-9-myapp-deadbeef',
        slot: 9,
        services: ['redis'],
        containerNames: ['wt-9-myapp-deadbeef-redis'],
      },
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

    // Registry slot 2 should remain — we must not touch its Docker project.
    expect(mockRemoveDockerServices).not.toHaveBeenCalledWith(tmpDir, 2, expect.any(Function));
    expect(mockRemoveDockerServices).toHaveBeenCalledWith(tmpDir, 7, expect.any(Function));
    expect(mockRemoveDockerServices).toHaveBeenCalledWith(tmpDir, 9, expect.any(Function));
    expect(mockWriteRegistry).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      data: {
        prunedManaged: unknown[];
        prunedOrphanDockerProjects: Array<{ slot: number; projectName: string; removed: boolean }>;
      };
    };
    expect(output.data.prunedManaged).toEqual([]);
    expect(output.data.prunedOrphanDockerProjects).toHaveLength(2);
    expect(output.data.prunedOrphanDockerProjects.map((o) => o.slot).sort()).toEqual([7, 9]);
    expect(output.data.prunedOrphanDockerProjects.every((o) => o.removed)).toBe(true);
  });

  it('reports orphan Docker projects in dry-run without touching Docker', async () => {
    mockListManagedDockerProjectsForRepo.mockReturnValue([
      {
        projectName: 'wt-9-myapp-deadbeef',
        slot: 9,
        services: ['redis'],
        containerNames: ['wt-9-myapp-deadbeef-redis'],
      },
    ]);
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);

    await pruneCommand({ json: true, keepDb: false, dryRun: true });

    expect(mockRemoveDockerServices).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      data: { orphanDockerProjects: Array<{ slot: number }> };
    };
    expect(output.data.orphanDockerProjects).toHaveLength(1);
    expect(output.data.orphanDockerProjects[0]?.slot).toBe(9);
  });

  it('reports nothing-to-prune cleanly when registry is empty and no orphans exist', async () => {
    mockReadRegistry.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);

    await pruneCommand({ json: true, keepDb: false, dryRun: false });

    expect(mockDropDatabase).not.toHaveBeenCalled();
    expect(mockRemoveDockerServices).not.toHaveBeenCalled();
    expect(mockWriteRegistry).not.toHaveBeenCalled();

    const output = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: {
        prunedManaged: unknown[];
        prunedUnmanaged: unknown[];
        prunedOrphanDockerProjects: unknown[];
        failed: unknown[];
      };
    };
    expect(output.success).toBe(true);
    expect(output.data.prunedManaged).toEqual([]);
    expect(output.data.prunedOrphanDockerProjects).toEqual([]);
  });
});
