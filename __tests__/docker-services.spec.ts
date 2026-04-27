import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as child_process from 'node:child_process';
import {
  buildDockerComposeConfig,
  computeServiceHashes,
  ensureDockerServices,
  getDockerProjectName,
  usesDockerServices,
} from '../src/core/docker-services';
import type { WtConfig } from '../src/types';

jest.mock('node:child_process');

describe('docker-services', () => {
  const config: WtConfig = {
    baseDatabaseName: 'cryptoacc',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 25,
    services: [
      { name: 'electric', defaultPort: 3004 },
      { name: 'redis', defaultPort: 6379 },
    ],
    dockerServices: [
      {
        name: 'redis',
        image: 'redis:8-alpine',
        restart: 'unless-stopped',
        ports: [{ service: 'redis', target: 6379, host: '127.0.0.1' }],
        environment: {},
        command: ['redis-server', '--requirepass', 'local_password'],
        volumes: [],
        extraHosts: [],
      },
      {
        name: 'electric',
        image: 'docker.io/electricsql/electric:subqueries-beta-7',
        restart: 'unless-stopped',
        ports: [{ service: 'electric', target: 3000, host: '127.0.0.1' }],
        environment: {
          DATABASE_URL: 'postgresql://user:password@host.docker.internal:5432/{{dbName}}?sslmode=disable',
          ELECTRIC_INSECURE: 'true',
          ELECTRIC_PORT: '{{ports.electric}}',
        },
        volumes: [],
        extraHosts: ['host.docker.internal:host-gateway'],
      },
    ],
    envFiles: [],
    postSetup: [],
    autoInstall: true,
  };

  it('detects whether docker services are configured', () => {
    expect(usesDockerServices(config)).toBe(true);
    expect(usesDockerServices({ ...config, dockerServices: [] })).toBe(false);
  });

  it('builds a deterministic Docker Compose project name from repo path and slot', () => {
    const name = getDockerProjectName('/Users/dev/My Project', 7);

    expect(name).toMatch(/^wt-7-my-project-[a-f0-9]{8}$/);
    expect(getDockerProjectName('/Users/dev/My Project', 7)).toBe(name);
  });

  it('renders compose services with allocated ports, labels, and template values', () => {
    const compose = buildDockerComposeConfig({
      mainRoot: '/Users/dev/My Project',
      slot: 3,
      branchName: 'feat/electric',
      worktreePath: '/Users/dev/My Project/.worktrees/feat-electric',
      dbName: 'cryptoacc_wt3',
      ports: { electric: 3304, redis: 6679 },
      config,
    });

    const projectName = getDockerProjectName('/Users/dev/My Project', 3);
    expect(compose.services.redis).toMatchObject({
      image: 'redis:8-alpine',
      container_name: `${projectName}-redis`,
      ports: ['127.0.0.1:6679:6379'],
      command: ['redis-server', '--requirepass', 'local_password'],
    });
    expect(compose.services.redis?.labels).toContain('dev.tokenbooks.wt.service=redis');
    expect(compose.services.redis?.labels).toContain('dev.tokenbooks.wt.slot=3');

    expect(compose.services.electric).toMatchObject({
      image: 'docker.io/electricsql/electric:subqueries-beta-7',
      container_name: `${projectName}-electric`,
      ports: ['127.0.0.1:3304:3000'],
      environment: {
        DATABASE_URL: 'postgresql://user:password@host.docker.internal:5432/cryptoacc_wt3?sslmode=disable',
        ELECTRIC_INSECURE: 'true',
        ELECTRIC_PORT: '3304',
      },
      extra_hosts: ['host.docker.internal:host-gateway'],
    });
  });

  describe('computeServiceHashes', () => {
    function configWithRedis(): WtConfig {
      return {
        ...config,
        dockerServices: [config.dockerServices[0]!], // redis only
      };
    }

    function buildOptions(overrides: Partial<{ ports: Record<string, number>; branchName: string }> = {}) {
      return {
        mainRoot: '/Users/dev/My Project',
        slot: 3,
        branchName: overrides.branchName ?? 'feat/electric',
        worktreePath: '/Users/dev/My Project/.worktrees/feat-electric',
        dbName: 'cryptoacc_wt3',
        ports: overrides.ports ?? { electric: 3304, redis: 6679 },
        config: configWithRedis(),
      };
    }

    it('returns one hash per docker service', () => {
      const compose = buildDockerComposeConfig(buildOptions());
      const hashes = computeServiceHashes(compose);

      expect(Object.keys(hashes)).toEqual(['redis']);
      expect(hashes.redis).toMatch(/^[a-f0-9]{12}$/);
    });

    it('produces identical hashes for identical compose configs', () => {
      const a = buildDockerComposeConfig(buildOptions());
      const b = buildDockerComposeConfig(buildOptions());

      expect(computeServiceHashes(a)).toEqual(computeServiceHashes(b));
    });

    it('produces different hashes when the rendered service differs', () => {
      const original = buildDockerComposeConfig(buildOptions());
      const portChanged = buildDockerComposeConfig(buildOptions({ ports: { electric: 3304, redis: 6699 } }));

      expect(computeServiceHashes(original).redis).not.toBe(computeServiceHashes(portChanged).redis);
    });
  });
});

describe('ensureDockerServices invocation', () => {
  let calls: string[][] = [];

  beforeEach(() => {
    calls = [];
    jest.mocked(child_process.execFileSync).mockImplementation((_cmd, args) => {
      calls.push([...(args as string[])]);
      return '';
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  const config: WtConfig = {
    baseDatabaseName: 'cryptoacc',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 25,
    services: [{ name: 'redis', defaultPort: 6379 }],
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
    envFiles: [],
    postSetup: [],
    autoInstall: true,
  };

  function runEnsure(extra: { recreateServices?: readonly string[] } = {}) {
    return ensureDockerServices({
      mainRoot: '/Users/dev/My Project',
      slot: 3,
      branchName: 'feat/x',
      worktreePath: '/Users/dev/My Project/.worktrees/x',
      dbName: 'cryptoacc_wt3',
      ports: { redis: 6679 },
      config,
      ...extra,
    });
  }

  it('uses the idempotent up path when recreateServices is omitted', () => {
    const result = runEnsure();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        'compose',
        '-f',
        expect.stringContaining('compose.json'),
        '-p',
        expect.stringContaining('wt-3-'),
        'up',
        '-d',
        '--no-recreate',
        '--remove-orphans',
      ]),
    );
    expect(result?.serviceHashes).toBeDefined();
    expect(Object.keys(result?.serviceHashes ?? {})).toEqual(['redis']);
  });

  it('uses the idempotent up path when recreateServices is empty', () => {
    runEnsure({ recreateServices: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        '-f',
        expect.stringContaining('compose.json'),
        '-p',
        expect.stringContaining('wt-3-'),
        '--no-recreate',
        '--remove-orphans',
      ]),
    );
  });

  it('does targeted stop+force-recreate then a final idempotent up when recreateServices is non-empty', () => {
    runEnsure({ recreateServices: ['redis'] });

    expect(calls).toHaveLength(3);
    // 1. stop
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        'compose',
        '-f',
        expect.stringContaining('compose.json'),
        '-p',
        expect.stringContaining('wt-3-'),
        'stop',
        'redis',
      ]),
    );
    // 2. force-recreate, no-deps, only the listed services
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        'compose',
        '-f',
        expect.stringContaining('compose.json'),
        '-p',
        expect.stringContaining('wt-3-'),
        'up',
        '-d',
        '--force-recreate',
        '--no-deps',
        'redis',
      ]),
    );
    // 3. final idempotent up to bring back unchanged services and prune orphans
    expect(calls[2]).toEqual(
      expect.arrayContaining([
        'compose',
        '-f',
        expect.stringContaining('compose.json'),
        '-p',
        expect.stringContaining('wt-3-'),
        'up',
        '-d',
        '--no-recreate',
        '--remove-orphans',
      ]),
    );
  });
});
