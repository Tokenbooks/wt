import { describe, expect, it } from '@jest/globals';
import {
  buildDockerComposeConfig,
  getDockerProjectName,
  usesDockerServices,
} from '../src/core/docker-services';
import type { WtConfig } from '../src/types';

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

    expect(name).toMatch(/^wt-my-project-[a-f0-9]{8}-slot-7$/);
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
});
