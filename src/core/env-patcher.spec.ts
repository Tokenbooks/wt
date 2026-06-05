import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { copyAndPatchAllEnvFiles, seedEnvFileDefaults } from './env-patcher';
import type { WtConfig } from '../types';

describe('seedEnvFileDefaults', () => {
  let tmpDir: string;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a missing target env file from the configured example', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-seed-create-'));
    fs.writeFileSync(
      path.join(tmpDir, '.env.example'),
      [
        '# Safe local defaults',
        'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp',
        'FEATURE_FLAG=true',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = seedEnvFileDefaults(
      [{ source: '.env', seedFrom: '.env.example' }],
      tmpDir,
      { dryRun: false },
    );

    expect(fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')).toBe(
      fs.readFileSync(path.join(tmpDir, '.env.example'), 'utf-8'),
    );
    expect(result.files).toEqual([
      {
        source: '.env.example',
        target: '.env',
        created: true,
        addedVars: ['DATABASE_URL', 'FEATURE_FLAG'],
      },
    ]);
    expect(result.changed).toBe(true);
  });

  it('adds missing vars from an example without overriding developer values', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-seed-merge-'));
    fs.writeFileSync(
      path.join(tmpDir, '.env.example'),
      [
        'API_KEY=example-value',
        'MISSING=safe-default',
        'export EXPORTED_FLAG=true',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      [
        'API_KEY=developer-secret',
        'LOCAL_ONLY=keep-me',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = seedEnvFileDefaults(
      [{ source: '.env', seedFrom: '.env.example' }],
      tmpDir,
      { dryRun: false },
    );

    const content = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8');
    expect(content).toContain('API_KEY=developer-secret');
    expect(content).not.toContain('API_KEY=example-value');
    expect(content).toContain('LOCAL_ONLY=keep-me');
    expect(content).toContain('# Added from .env.example by wt');
    expect(content).toContain('MISSING=safe-default');
    expect(content).toContain('export EXPORTED_FLAG=true');
    expect(result.files[0]).toEqual({
      source: '.env.example',
      target: '.env',
      created: false,
      addedVars: ['MISSING', 'EXPORTED_FLAG'],
    });
    expect(result.changed).toBe(true);
  });

  it('reports missing vars during dry run without writing the target', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-seed-dry-'));
    fs.writeFileSync(path.join(tmpDir, '.env.example'), 'A=1\nB=2\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.env'), 'A=developer\n', 'utf-8');

    const result = seedEnvFileDefaults(
      [{ source: '.env', seedFrom: '.env.example' }],
      tmpDir,
      { dryRun: true },
    );

    expect(fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')).toBe('A=developer\n');
    expect(result.files[0]).toEqual({
      source: '.env.example',
      target: '.env',
      created: false,
      addedVars: ['B'],
    });
    expect(result.changed).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});

describe('copyAndPatchAllEnvFiles with seedFrom', () => {
  let mainRoot: string;
  let worktreeRoot: string;

  afterEach(() => {
    fs.rmSync(mainRoot, { recursive: true, force: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('copies main env, fills missing example vars in the worktree, then applies slot patches', () => {
    mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-main-'));
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-worktree-'));
    fs.writeFileSync(
      path.join(mainRoot, '.env'),
      [
        'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp',
        'LOCAL_VALUE=from-main',
        '',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(worktreeRoot, '.env.example'),
      [
        'DATABASE_URL=postgresql://user:pw@localhost:5432/myapp',
        'API_URL=http://localhost:4000/api',
        'SAFE_DEFAULT=true',
        '',
      ].join('\n'),
      'utf-8',
    );

    const config: WtConfig = {
      baseDatabaseName: 'myapp',
      baseWorktreePath: '.worktrees',
      portStride: 100,
      maxSlots: 50,
      services: [{ name: 'api', defaultPort: 4000 }],
      dockerServices: [],
      envFiles: [
        {
          source: '.env',
          seedFrom: '.env.example',
          patches: [
            { var: 'DATABASE_URL', type: 'database' },
            { var: 'API_URL', type: 'url', service: 'api' },
          ],
        },
      ],
      postSetup: [],
      autoInstall: true,
    };

    copyAndPatchAllEnvFiles(config, mainRoot, worktreeRoot, {
      dbName: 'myapp_wt2',
      ports: { api: 4200 },
      branchName: 'feat/env-seed',
    });

    const content = fs.readFileSync(path.join(worktreeRoot, '.env'), 'utf-8');
    expect(content).toContain('DATABASE_URL=postgresql://user:pw@localhost:5432/myapp_wt2');
    expect(content).toContain('LOCAL_VALUE=from-main');
    expect(content).toContain('API_URL=http://localhost:4200/api');
    expect(content).toContain('SAFE_DEFAULT=true');
  });

  it('supports seed-only env files without patches', () => {
    mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-main-'));
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-env-worktree-'));
    fs.writeFileSync(path.join(worktreeRoot, 'worker.env.example'), 'WORKER_ENABLED=true\n', 'utf-8');

    const config: WtConfig = {
      baseDatabaseName: 'myapp',
      baseWorktreePath: '.worktrees',
      portStride: 100,
      maxSlots: 50,
      services: [{ name: 'api', defaultPort: 4000 }],
      dockerServices: [],
      envFiles: [
        {
          source: 'worker.env',
          seedFrom: 'worker.env.example',
        },
      ],
      postSetup: [],
      autoInstall: true,
    };

    copyAndPatchAllEnvFiles(config, mainRoot, worktreeRoot, {
      dbName: 'myapp_wt2',
      ports: { api: 4200 },
      branchName: 'feat/env-seed',
    });

    expect(fs.readFileSync(path.join(worktreeRoot, 'worker.env'), 'utf-8')).toBe(
      'WORKER_ENABLED=true\n',
    );
  });
});
