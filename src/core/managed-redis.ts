import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ServiceConfig, WtConfig } from '../types';

const MANAGED_REDIS_SERVICE_NAME = 'redis';
const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_IMAGE = 'redis:8-alpine';
const DOCKER_LABEL_PREFIX = 'dev.tokenbooks.wt';

interface EnsureManagedRedisContainerOptions {
  readonly mainRoot: string;
  readonly slot: number;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly port: number;
  readonly sourceUrl: string | null;
  readonly log?: (message: string) => void;
}

interface DockerInspectPortBinding {
  readonly HostIp?: string;
  readonly HostPort?: string;
}

interface DockerInspectRecord {
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Record<string, string>;
  };
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, DockerInspectPortBinding[] | null>;
  };
  readonly State?: {
    readonly Running?: boolean;
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'repo';
}

function repoHash(mainRoot: string): string {
  return crypto
    .createHash('sha1')
    .update(mainRoot)
    .digest('hex')
    .slice(0, 8);
}

function runDocker(args: readonly string[]): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error('Docker CLI not found on PATH.');
    }
    const stderr = err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr?: Buffer | string }).stderr ?? '').trim()
      : '';
    throw new Error(stderr || `Docker command failed: docker ${args.join(' ')}`);
  }
}

function inspectManagedRedisContainer(containerName: string): DockerInspectRecord | null {
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

function parseManagedRedisPassword(sourceUrl: string | null): string | undefined {
  if (!sourceUrl) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'redis:') {
    throw new Error(`Managed Redis only supports redis:// URLs, got: ${parsed.protocol}//`);
  }
  if (parsed.username && parsed.username !== 'default') {
    throw new Error(
      `Managed Redis does not support non-default ACL usernames in REDIS_URL, got: ${parsed.username}`,
    );
  }
  return parsed.password || undefined;
}

function passwordHash(password: string | undefined): string {
  return crypto
    .createHash('sha256')
    .update(password ?? '')
    .digest('hex');
}

export function usesManagedRedis(config: WtConfig): boolean {
  return config.envFiles.some((envFile) => envFile.patches.some((patch) => patch.type === 'redis'));
}

export function getManagedRedisService(config: WtConfig): ServiceConfig | null {
  if (!usesManagedRedis(config)) {
    return null;
  }

  const configured = config.services.find((service) => service.name === MANAGED_REDIS_SERVICE_NAME);
  if (configured) {
    return configured;
  }

  return {
    name: MANAGED_REDIS_SERVICE_NAME,
    defaultPort: DEFAULT_REDIS_PORT,
  };
}

export function getAllocationServices(config: WtConfig): readonly ServiceConfig[] {
  const redisService = getManagedRedisService(config);
  if (!redisService) {
    return config.services;
  }
  if (config.services.some((service) => service.name === MANAGED_REDIS_SERVICE_NAME)) {
    return config.services;
  }
  return [...config.services, redisService];
}

export function getManagedRedisContainerName(mainRoot: string, slot: number): string {
  const repoName = slugify(path.basename(mainRoot));
  return `wt-${repoName}-${repoHash(mainRoot)}-slot-${slot}-redis`;
}

export function readManagedRedisSourceUrl(
  mainRoot: string,
  config: WtConfig,
): string | null {
  for (const envFile of config.envFiles) {
    const redisVars = envFile.patches
      .filter((patch) => patch.type === 'redis')
      .map((patch) => patch.var);
    if (redisVars.length === 0) {
      continue;
    }

    const sourcePath = path.join(mainRoot, envFile.source);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const content = fs.readFileSync(sourcePath, 'utf-8');
    for (const redisVar of redisVars) {
      const match = content.match(new RegExp(`^${redisVar}=["']?([^"'\\n]+)`, 'm'));
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return null;
}

export function patchManagedRedisUrl(sourceUrl: string, port: number): string {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'redis:') {
    throw new Error(`Managed Redis only supports redis:// URLs, got: ${parsed.protocol}//`);
  }

  parsed.hostname = '127.0.0.1';
  parsed.port = String(port);
  parsed.pathname = '/0';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function ensureManagedRedisContainer(
  options: EnsureManagedRedisContainerOptions,
): string {
  const containerName = getManagedRedisContainerName(options.mainRoot, options.slot);
  const inspect = inspectManagedRedisContainer(containerName);
  const password = parseManagedRedisPassword(options.sourceUrl);
  const expectedPasswordHash = passwordHash(password);
  const expectedPort = String(options.port);

  if (inspect) {
    const actualPort = inspect.NetworkSettings?.Ports?.['6379/tcp']?.[0]?.HostPort;
    const actualPasswordHash = inspect.Config?.Labels?.[`${DOCKER_LABEL_PREFIX}.redis-password-sha256`];
    const actualRepoRoot = inspect.Config?.Labels?.[`${DOCKER_LABEL_PREFIX}.repo-root`];
    const shouldRecreate = actualPort !== expectedPort
      || actualPasswordHash !== expectedPasswordHash
      || actualRepoRoot !== options.mainRoot
      || inspect.Config?.Image !== DEFAULT_REDIS_IMAGE;

    if (shouldRecreate) {
      runDocker(['rm', '-f', containerName]);
    } else {
      if (!inspect.State?.Running) {
        runDocker(['start', containerName]);
        options.log?.(`Started Redis container '${containerName}'.`);
      } else {
        options.log?.(`Reusing Redis container '${containerName}'.`);
      }
      return containerName;
    }
  }

  const args = [
    'run',
    '-d',
    '--name',
    containerName,
    '--restart',
    'unless-stopped',
    '--label',
    `${DOCKER_LABEL_PREFIX}.managed=true`,
    '--label',
    `${DOCKER_LABEL_PREFIX}.repo-root=${options.mainRoot}`,
    '--label',
    `${DOCKER_LABEL_PREFIX}.service=redis`,
    '--label',
    `${DOCKER_LABEL_PREFIX}.purpose=git-worktree-redis`,
    '--label',
    `${DOCKER_LABEL_PREFIX}.slot=${options.slot}`,
    '--label',
    `${DOCKER_LABEL_PREFIX}.branch=${options.branchName}`,
    '--label',
    `${DOCKER_LABEL_PREFIX}.worktree=${options.worktreePath}`,
    '--label',
    `${DOCKER_LABEL_PREFIX}.redis-password-sha256=${expectedPasswordHash}`,
    '-p',
    `127.0.0.1:${options.port}:6379`,
    DEFAULT_REDIS_IMAGE,
    'redis-server',
    '--save',
    '',
    '--appendonly',
    'no',
    '--port',
    '6379',
  ];

  if (password) {
    args.push('--requirepass', password);
  }

  runDocker(args);
  options.log?.(`Started Redis container '${containerName}' on port ${options.port}.`);
  return containerName;
}

export function removeManagedRedisContainer(
  mainRoot: string,
  slot: number,
  log?: (message: string) => void,
): boolean {
  const containerName = getManagedRedisContainerName(mainRoot, slot);
  const inspect = inspectManagedRedisContainer(containerName);
  if (!inspect) {
    log?.(`Skipping Redis container cleanup; not found: ${containerName}`);
    return false;
  }

  runDocker(['rm', '-f', containerName]);
  log?.(`Removed Redis container '${containerName}'.`);
  return true;
}
