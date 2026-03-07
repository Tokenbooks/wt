import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAllocationServices,
  getManagedRedisContainerName,
  patchManagedRedisUrl,
  readManagedRedisSourceUrl,
  usesManagedRedis,
} from '../src/core/managed-redis';
import type { WtConfig } from '../src/types';

describe('managed-redis', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-redis-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const configWithRedis: WtConfig = {
    baseDatabaseName: 'cryptoacc',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 25,
    services: [{ name: 'web', defaultPort: 3000 }],
    envFiles: [
      {
        source: '.env',
        patches: [{ var: 'REDIS_URL', type: 'redis', service: 'redis' }],
      },
    ],
    postSetup: [],
    autoInstall: true,
  };

  it('detects when managed redis is enabled', () => {
    expect(usesManagedRedis(configWithRedis)).toBe(true);
    expect(usesManagedRedis({ ...configWithRedis, envFiles: [] })).toBe(false);
  });

  it('auto-adds a redis service when redis patching is enabled', () => {
    expect(getAllocationServices(configWithRedis)).toEqual([
      { name: 'web', defaultPort: 3000 },
      { name: 'redis', defaultPort: 6379 },
    ]);
  });

  it('reuses the configured redis service when present', () => {
    const config: WtConfig = {
      ...configWithRedis,
      services: [
        { name: 'web', defaultPort: 3000 },
        { name: 'redis', defaultPort: 6380 },
      ],
    };

    expect(getAllocationServices(config)).toEqual(config.services);
  });

  it('patches redis urls to localhost db 0 on the allocated port', () => {
    expect(
      patchManagedRedisUrl('redis://:local_password@localhost:6379/9', 6479),
    ).toBe('redis://:local_password@127.0.0.1:6479/0');
  });

  it('reads the base redis url from a configured env file', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'DATABASE_URL=postgresql://localhost:5432/cryptoacc\nREDIS_URL=redis://:secret@localhost:6379/0\n',
      'utf-8',
    );

    expect(readManagedRedisSourceUrl(tmpDir, configWithRedis)).toBe(
      'redis://:secret@localhost:6379/0',
    );
  });

  it('builds a deterministic docker container name from repo path and slot', () => {
    const name = getManagedRedisContainerName('/Users/dev/My Project', 7);

    expect(name).toMatch(/^wt-my-project-[a-f0-9]{8}-slot-7-redis$/);
    expect(getManagedRedisContainerName('/Users/dev/My Project', 7)).toBe(name);
  });
});
