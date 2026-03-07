import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/commands/setup';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates legacy redis config to an explicit redis service on first load', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'wt.config.json'),
      JSON.stringify({
        baseDatabaseName: 'myapp',
        services: [{ name: 'web', defaultPort: 3000 }],
        envFiles: [
          {
            source: '.env',
            patches: [
              { var: 'REDIS_URL', type: 'redis' },
            ],
          },
        ],
      }, null, 2),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'REDIS_URL=redis://:local_password@127.0.0.1:6380/0\n',
    );

    const config = loadConfig(tmpDir);

    expect(config.services).toContainEqual({ name: 'redis', defaultPort: 6380 });
    expect(config.envFiles[0]?.patches[0]).toEqual({
      var: 'REDIS_URL',
      type: 'redis',
      service: 'redis',
    });

    const rewritten = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'wt.config.json'), 'utf-8'),
    ) as {
      services: Array<{ name: string; defaultPort: number }>;
      envFiles: Array<{ patches: Array<{ var: string; type: string; service?: string }> }>;
    };

    expect(rewritten.services).toContainEqual({ name: 'redis', defaultPort: 6380 });
    expect(rewritten.envFiles[0]?.patches[0]?.service).toBe('redis');
  });

  it('rejects configs whose generated ports collide across slots', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'wt.config.json'),
      JSON.stringify({
        baseDatabaseName: 'myapp',
        portStride: 100,
        maxSlots: 5,
        services: [
          { name: 'web', defaultPort: 3000 },
          { name: 'worker', defaultPort: 3100 },
        ],
        envFiles: [],
      }, null, 2),
    );

    expect(() => loadConfig(tmpDir)).toThrow('collides');
  });
});
