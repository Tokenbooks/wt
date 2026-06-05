import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('../core/git', () => ({
  getMainWorktreePath: jest.fn(),
}));

jest.mock('../core/env-patcher', () => ({
  seedEnvFileDefaults: jest.fn(),
}));

jest.mock('./setup', () => ({
  loadConfig: jest.fn(),
}));

import { getMainWorktreePath } from '../core/git';
import { seedEnvFileDefaults } from '../core/env-patcher';
import { loadConfig } from './setup';
import { envSeedCommand } from './env';
import type { WtConfig } from '../types';

const mockGetMainWorktreePath = getMainWorktreePath as jest.MockedFunction<typeof getMainWorktreePath>;
const mockSeedEnvFileDefaults =
  seedEnvFileDefaults as jest.MockedFunction<typeof seedEnvFileDefaults>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

describe('env seed command', () => {
  let tmpDir: string;
  let targetDir: string;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

  const config: WtConfig = {
    baseDatabaseName: 'myapp',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 50,
    services: [{ name: 'web', defaultPort: 3000 }],
    dockerServices: [],
    envFiles: [{ source: '.env', seedFrom: '.env.example' }],
    postSetup: [],
    autoInstall: true,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-command-'));
    targetDir = path.join(tmpDir, '.worktrees', 'feat-env');
    fs.mkdirSync(targetDir, { recursive: true });
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockGetMainWorktreePath.mockReturnValue(tmpDir);
    mockLoadConfig.mockReturnValue(config);
    mockSeedEnvFileDefaults.mockReturnValue({
      dryRun: false,
      changed: true,
      files: [
        {
          source: '.env.example',
          target: '.env',
          created: true,
          addedVars: ['DATABASE_URL'],
        },
      ],
    });
    process.exitCode = 0;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('seeds env files for any target path, including the main worktree', () => {
    envSeedCommand(tmpDir, { json: true, dryRun: false });

    expect(mockLoadConfig).toHaveBeenCalledWith(tmpDir);
    expect(mockSeedEnvFileDefaults).toHaveBeenCalledWith(
      config.envFiles,
      tmpDir,
      { dryRun: false },
    );
    const payload = JSON.parse(consoleLogSpy.mock.calls[0]?.[0] ?? 'null') as {
      success: boolean;
      data: { files: unknown[]; changed: boolean };
    };
    expect(payload.success).toBe(true);
    expect(payload.data.changed).toBe(true);
    expect(payload.data.files).toHaveLength(1);
  });

  it('passes dry-run through to the seed helper for branch worktrees', () => {
    mockSeedEnvFileDefaults.mockReturnValue({
      dryRun: true,
      changed: true,
      files: [
        {
          source: '.env.example',
          target: '.env',
          created: true,
          addedVars: ['DATABASE_URL'],
        },
      ],
    });

    envSeedCommand(targetDir, { json: false, dryRun: true });

    expect(mockSeedEnvFileDefaults).toHaveBeenCalledWith(
      config.envFiles,
      targetDir,
      { dryRun: true },
    );
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('[dry-run]');
  });
});
