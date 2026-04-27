import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ensureDockerServices,
  getDockerProjectName,
  listManagedDockerProjectsForRepo,
  removeDockerServices,
} from '../src/core/docker-services';
import type { WtConfig } from '../src/types';

const describeDocker = process.env.WT_RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const SLOT = 42;

async function reserveFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  return address.port;
}

async function pingRedis(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let finished = false;
    let response = '';
    const finish = (value: boolean) => {
      if (!finished) {
        finished = true;
        resolve(value);
      }
    };

    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.write('*1\r\n$4\r\nPING\r\n');
    });
    socket.on('data', (chunk: Buffer | string) => {
      response += chunk.toString();
      if (response.includes('PONG')) {
        socket.end();
        finish(true);
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      finish(false);
    });
    socket.on('error', () => {
      finish(false);
    });
    socket.on('close', () => {
      finish(response.includes('PONG'));
    });
  });
}

async function waitForRedis(port: number, timeoutMs = 30000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pingRedis(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Redis did not respond on port ${port} within ${timeoutMs}ms.`);
}

describeDocker('docker-services integration', () => {
  jest.setTimeout(120000);

  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-docker-services-'));
  const worktreePath = path.join(mainRoot, '.worktrees', 'feat-integration');
  const branchName = 'feat/integration';

  const config: WtConfig = {
    baseDatabaseName: 'myapp',
    baseWorktreePath: '.worktrees',
    portStride: 100,
    maxSlots: 50,
    services: [{ name: 'redis', defaultPort: 6379 }],
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

  afterEach(() => {
    removeDockerServices(mainRoot, SLOT);
  });

  afterAll(() => {
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });

  it('creates, lists, and removes real Docker Compose-managed services', async () => {
    const port = await reserveFreePort();
    const projectName = getDockerProjectName(mainRoot, SLOT);

    const allocation = ensureDockerServices({
      mainRoot,
      slot: SLOT,
      branchName,
      worktreePath,
      dbName: 'myapp_wt42',
      ports: { redis: port },
      config,
    });

    expect(allocation).toEqual({
      projectName,
      services: ['redis'],
      serviceHashes: { redis: expect.stringMatching(/^[a-f0-9]{12}$/) as unknown as string },
    });
    await waitForRedis(port);

    const projects = listManagedDockerProjectsForRepo(mainRoot);
    expect(projects).toContainEqual({
      projectName,
      slot: SLOT,
      branch: branchName,
      worktreePath,
      services: ['redis'],
      containerNames: [`${projectName}-redis`],
    });

    expect(removeDockerServices(mainRoot, SLOT)).toBe(true);
    expect(listManagedDockerProjectsForRepo(mainRoot)).toEqual([]);
    expect(removeDockerServices(mainRoot, SLOT)).toBe(false);
  });
});
