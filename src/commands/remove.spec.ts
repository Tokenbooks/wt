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

jest.mock('../core/docker-services', () => ({
  removeDockerServices: jest.fn(),
  usesDockerServices: jest.fn(),
}));

jest.mock('../core/git', () => ({
  getMainWorktreePath: jest.fn(),
  removeWorktree: jest.fn(),
  getUncommittedChanges: jest.fn(),
  getUnsyncedStatus: jest.fn(),
}));

jest.mock('./setup', () => ({
  loadConfig: jest.fn(),
}));

import { readRegistry, writeRegistry, removeAllocation } from '../core/registry';
import { dropDatabase } from '../core/database';
import { removeDockerServices, usesDockerServices } from '../core/docker-services';
import { getMainWorktreePath } from '../core/git';
import { loadConfig } from './setup';
import { parseRemoveTargets, removeCommand } from './remove';
import type { Allocation, Registry, WtConfig } from '../types';

const mockReadRegistry = readRegistry as jest.MockedFunction<typeof readRegistry>;
const mockWriteRegistry = writeRegistry as jest.MockedFunction<typeof writeRegistry>;
const mockRemoveAllocation = removeAllocation as jest.MockedFunction<typeof removeAllocation>;
const mockDropDatabase = dropDatabase as jest.MockedFunction<typeof dropDatabase>;
const mockRemoveDockerServices =
  removeDockerServices as jest.MockedFunction<typeof removeDockerServices>;
const mockUsesDockerServices = usesDockerServices as jest.MockedFunction<typeof usesDockerServices>;
const mockGetMainWorktreePath =
  getMainWorktreePath as jest.MockedFunction<typeof getMainWorktreePath>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

describe('remove command target parsing', () => {
  it('parses comma-separated slots', () => {
    expect(parseRemoveTargets(['1,2'])).toEqual(['1', '2']);
  });

  it('parses comma-separated slots with spaces', () => {
    expect(parseRemoveTargets(['1, 2'])).toEqual(['1', '2']);
  });

  it('parses mixed comma and variadic targets', () => {
    expect(parseRemoveTargets(['1, 2', '3'])).toEqual(['1', '2', '3']);
  });

  it('keeps single path targets untouched', () => {
    expect(parseRemoveTargets(['.worktrees/feat-auth'])).toEqual(['.worktrees/feat-auth']);
  });

  it('drops empty target fragments', () => {
    expect(parseRemoveTargets(['1,,2', ' , '])).toEqual(['1', '2']);
  });
});

describe('remove command teardown order', () => {
  let tmpDir: string;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

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

  const allocation: Allocation = {
    worktreePath: '/repo/.worktrees/feat-x',
    branchName: 'feat/x',
    dbName: 'myapp_wt1',
    docker: { projectName: 'wt-1-myapp-abcd1234', services: ['electric'] },
    ports: { web: 3100 },
    createdAt: '2026-03-24T00:00:00.000Z',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remove-test-'));
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp\n',
      'utf-8',
    );

    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    mockGetMainWorktreePath.mockReturnValue(tmpDir);
    mockLoadConfig.mockReturnValue(config);
    mockReadRegistry.mockReturnValue({
      version: 1,
      allocations: { '1': allocation },
    } satisfies Registry);
    mockUsesDockerServices.mockReturnValue(true);
    mockRemoveDockerServices.mockReturnValue(true);
    mockDropDatabase.mockResolvedValue(undefined);
    mockRemoveAllocation.mockReturnValue({ version: 1, allocations: {} } satisfies Registry);
    process.exitCode = 0;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
    process.exitCode = 0;
  });

  it('removes Docker services before dropping the database', async () => {
    // Act
    await removeCommand(['1'], { json: true, keepDb: false, all: false, force: true });

    // Assert: Electric (a Docker service) is torn down before DROP DATABASE, so
    // the logical replication slot is released before Postgres drops the DB.
    expect(mockRemoveDockerServices).toHaveBeenCalledTimes(1);
    expect(mockDropDatabase).toHaveBeenCalledTimes(1);
    const dockerOrder = mockRemoveDockerServices.mock.invocationCallOrder[0];
    const dropOrder = mockDropDatabase.mock.invocationCallOrder[0];
    if (dockerOrder === undefined || dropOrder === undefined) {
      throw new Error('expected both teardown steps to run');
    }
    expect(dockerOrder).toBeLessThan(dropOrder);
    expect(mockWriteRegistry).toHaveBeenCalledTimes(1);
  });

  it('skips the database drop under --keep-db but still removes Docker services', async () => {
    // Act
    await removeCommand(['1'], { json: true, keepDb: true, all: false, force: true });

    // Assert
    expect(mockRemoveDockerServices).toHaveBeenCalledTimes(1);
    expect(mockDropDatabase).not.toHaveBeenCalled();
  });
});
