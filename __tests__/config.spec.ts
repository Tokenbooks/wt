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

  it('rejects legacy redis patch configs', () => {
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

    expect(() => loadConfig(tmpDir)).toThrow();
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

  it('rejects docker services that reference unknown port services', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'wt.config.json'),
      JSON.stringify({
        baseDatabaseName: 'myapp',
        services: [{ name: 'web', defaultPort: 3000 }],
        dockerServices: [
          {
            name: 'electric',
            image: 'docker.io/electricsql/electric:latest',
            ports: [{ service: 'electric', target: 3000 }],
          },
        ],
        envFiles: [],
      }, null, 2),
    );

    expect(() => loadConfig(tmpDir)).toThrow(
      "Docker service 'electric' references unknown port service 'electric'.",
    );
  });
});
