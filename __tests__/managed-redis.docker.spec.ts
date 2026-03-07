import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  ensureManagedRedisContainer,
  getManagedRedisContainerName,
  removeManagedRedisContainer,
} from '../src/core/managed-redis';

const describeDocker = process.env.WT_RUN_DOCKER_TESTS === '1' ? describe : describe.skip;
const SLOT = 42;

interface DockerInspectRecord {
  readonly Id: string;
  readonly Config?: {
    readonly Labels?: Record<string, string>;
  };
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

function runDocker(args: readonly string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

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

function inspectContainer(containerName: string): DockerInspectRecord | null {
  try {
    const raw = runDocker(['container', 'inspect', containerName]);
    const parsed = JSON.parse(raw) as DockerInspectRecord[];
    return parsed[0] ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No such container')) {
      return null;
    }
    throw err;
  }
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

describeDocker('managed-redis docker integration', () => {
  jest.setTimeout(120000);

  const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-managed-redis-docker-'));
  const worktreePath = path.join(mainRoot, '.worktrees', 'feat-integration');
  const branchName = 'feat/integration';
  const containerName = getManagedRedisContainerName(mainRoot, SLOT);

  afterEach(() => {
    removeManagedRedisContainer(mainRoot, SLOT);
  });

  afterAll(() => {
    fs.rmSync(mainRoot, { recursive: true, force: true });
  });

  it('creates, reuses, and removes a real Docker-managed Redis container', async () => {
    const port = await reserveFreePort();

    const firstName = ensureManagedRedisContainer({
      mainRoot,
      slot: SLOT,
      branchName,
      worktreePath,
      port,
      sourceUrl: 'redis://127.0.0.1:6379/0',
    });

    expect(firstName).toBe(containerName);
    await waitForRedis(port);

    const firstInspect = inspectContainer(containerName);
    expect(firstInspect).not.toBeNull();
    expect(firstInspect?.NetworkSettings?.Ports?.['6379/tcp']?.[0]?.HostIp).toBe('127.0.0.1');
    expect(firstInspect?.NetworkSettings?.Ports?.['6379/tcp']?.[0]?.HostPort).toBe(String(port));
    expect(firstInspect?.Config?.Labels?.['dev.tokenbooks.wt.managed']).toBe('true');
    expect(firstInspect?.Config?.Labels?.['dev.tokenbooks.wt.purpose']).toBe('git-worktree-redis');
    expect(firstInspect?.Config?.Labels?.['dev.tokenbooks.wt.slot']).toBe(String(SLOT));
    expect(firstInspect?.Config?.Labels?.['dev.tokenbooks.wt.branch']).toBe(branchName);
    expect(firstInspect?.Config?.Labels?.['dev.tokenbooks.wt.worktree']).toBe(worktreePath);

    const secondName = ensureManagedRedisContainer({
      mainRoot,
      slot: SLOT,
      branchName,
      worktreePath,
      port,
      sourceUrl: 'redis://127.0.0.1:6379/0',
    });

    const secondInspect = inspectContainer(containerName);
    expect(secondName).toBe(containerName);
    expect(secondInspect?.Id).toBe(firstInspect?.Id);

    expect(removeManagedRedisContainer(mainRoot, SLOT)).toBe(true);
    expect(inspectContainer(containerName)).toBeNull();
    expect(removeManagedRedisContainer(mainRoot, SLOT)).toBe(false);
  });
});
