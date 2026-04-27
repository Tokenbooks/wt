import * as crypto from 'node:crypto';
// Namespace import required: jest.mock('node:child_process') replaces the
// module object's properties at runtime; a named destructured import would
// bypass the mock and the invocation tests would actually shell out.
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DockerServiceConfig, WtConfig } from '../types';

const DOCKER_LABEL_PREFIX = 'dev.tokenbooks.wt';

export interface EnsureDockerServicesOptions {
  readonly mainRoot: string;
  readonly slot: number;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly dbName: string;
  readonly ports: Record<string, number>;
  readonly config: WtConfig;
  readonly log?: (message: string) => void;
  /**
   * Names of docker services to stop-and-force-recreate. When omitted or
   * empty, only missing containers are created (`--no-recreate`).
   */
  readonly recreateServices?: readonly string[];
}

export interface DockerServicesAllocation {
  readonly projectName: string;
  readonly services: string[];
  readonly serviceHashes: Record<string, string>;
}

export interface ManagedDockerProjectSummary {
  readonly projectName: string;
  readonly slot: number;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly services: string[];
  readonly containerNames: string[];
}

interface DockerInspectRecord {
  readonly Config?: {
    readonly Labels?: Record<string, string>;
  };
}

export interface DockerComposeService {
  readonly image: string;
  readonly container_name: string;
  readonly restart: string;
  readonly labels: string[];
  readonly ports?: string[];
  readonly environment?: Record<string, string>;
  readonly command?: string | string[];
  readonly volumes?: string[];
  readonly extra_hosts?: string[];
}

export interface DockerComposeConfig {
  readonly services: Record<string, DockerComposeService>;
}

/**
 * Compute a stable per-service hash of the rendered compose config. Used
 * by `wt setup` to detect which services have a changed configuration
 * and need to be recreated. The hash includes every rendered field
 * (image, labels, ports, environment, command, volumes, extra_hosts) so
 * any user-visible config change produces a new hash.
 */
export function computeServiceHashes(
  compose: DockerComposeConfig,
): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, service] of Object.entries(compose.services)) {
    const json = JSON.stringify(service);
    hashes[name] = crypto.createHash('sha256').update(json).digest('hex').slice(0, 12);
  }
  return hashes;
}

interface DockerRenderContext {
  readonly mainRoot: string;
  readonly slot: number;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly dbName: string;
  readonly ports: Record<string, number>;
  readonly projectName: string;
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
    return child_process.execFileSync('docker', args, {
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

function inspectDockerContainer(containerName: string): DockerInspectRecord | null {
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

function renderTemplate(value: string, context: DockerRenderContext): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    const values: Record<string, string> = {
      mainRoot: context.mainRoot,
      slot: String(context.slot),
      branchName: context.branchName,
      worktreePath: context.worktreePath,
      dbName: context.dbName,
      projectName: context.projectName,
    };

    for (const [serviceName, port] of Object.entries(context.ports)) {
      values[`ports.${serviceName}`] = String(port);
      values[`services.${serviceName}.port`] = String(port);
    }

    return values[key] ?? match;
  });
}

function renderTemplateArray(values: readonly string[], context: DockerRenderContext): string[] {
  return values.map((value) => renderTemplate(value, context));
}

function renderCommand(
  command: DockerServiceConfig['command'],
  context: DockerRenderContext,
): string | string[] | undefined {
  if (command === undefined) {
    return undefined;
  }
  if (Array.isArray(command)) {
    return renderTemplateArray(command, context);
  }
  return renderTemplate(command, context);
}

function renderEnvironment(
  environment: Record<string, string>,
  context: DockerRenderContext,
): Record<string, string> | undefined {
  const entries = Object.entries(environment);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    entries.map(([key, value]) => [key, renderTemplate(value, context)]),
  );
}

function renderPorts(
  service: DockerServiceConfig,
  context: DockerRenderContext,
): string[] | undefined {
  if (service.ports.length === 0) {
    return undefined;
  }

  return service.ports.map((port) => {
    const allocatedPort = context.ports[port.service];
    if (allocatedPort === undefined) {
      throw new Error(
        `Docker service '${service.name}' references unknown port service '${port.service}'.`,
      );
    }
    return `${port.host}:${allocatedPort}:${port.target}`;
  });
}

function composePath(projectName: string): string {
  const dir = path.join(os.tmpdir(), 'wt-docker-compose', projectName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'compose.json');
}

function writeComposeFile(projectName: string, compose: DockerComposeConfig): string {
  const filePath = composePath(projectName);
  fs.writeFileSync(filePath, JSON.stringify(compose, null, 2) + '\n', 'utf-8');
  return filePath;
}

export function usesDockerServices(config: WtConfig): boolean {
  return config.dockerServices.length > 0;
}

export function getDockerProjectName(mainRoot: string, slot: number): string {
  const repoName = slugify(path.basename(mainRoot));
  return `wt-${slot}-${repoName}-${repoHash(mainRoot)}`;
}

export function buildDockerComposeConfig(options: EnsureDockerServicesOptions): DockerComposeConfig {
  const projectName = getDockerProjectName(options.mainRoot, options.slot);
  const context: DockerRenderContext = {
    mainRoot: options.mainRoot,
    slot: options.slot,
    branchName: options.branchName,
    worktreePath: options.worktreePath,
    dbName: options.dbName,
    ports: options.ports,
    projectName,
  };

  const services: Record<string, DockerComposeService> = {};
  for (const service of options.config.dockerServices) {
    const labels = [
      `${DOCKER_LABEL_PREFIX}.managed=true`,
      `${DOCKER_LABEL_PREFIX}.repo-root=${options.mainRoot}`,
      `${DOCKER_LABEL_PREFIX}.project=${projectName}`,
      `${DOCKER_LABEL_PREFIX}.service=${service.name}`,
      `${DOCKER_LABEL_PREFIX}.slot=${options.slot}`,
      `${DOCKER_LABEL_PREFIX}.branch=${options.branchName}`,
      `${DOCKER_LABEL_PREFIX}.worktree=${options.worktreePath}`,
    ];
    const composeService: DockerComposeService = {
      image: renderTemplate(service.image, context),
      container_name: `${projectName}-${service.name}`,
      restart: service.restart,
      labels,
    };
    const ports = renderPorts(service, context);
    if (ports) {
      Object.assign(composeService, { ports });
    }
    const environment = renderEnvironment(service.environment, context);
    if (environment) {
      Object.assign(composeService, { environment });
    }
    const command = renderCommand(service.command, context);
    if (command !== undefined) {
      Object.assign(composeService, { command });
    }
    if (service.volumes.length > 0) {
      Object.assign(composeService, {
        volumes: renderTemplateArray(service.volumes, context),
      });
    }
    if (service.extraHosts.length > 0) {
      Object.assign(composeService, {
        extra_hosts: renderTemplateArray(service.extraHosts, context),
      });
    }
    services[service.name] = composeService;
  }

  return { services };
}

export function ensureDockerServices(
  options: EnsureDockerServicesOptions,
): DockerServicesAllocation | undefined {
  if (!usesDockerServices(options.config)) {
    return undefined;
  }

  const projectName = getDockerProjectName(options.mainRoot, options.slot);
  const compose = buildDockerComposeConfig(options);
  const filePath = writeComposeFile(projectName, compose);

  const serviceHashes = computeServiceHashes(compose);

  const recreate = options.recreateServices ?? [];
  if (recreate.length > 0) {
    runDocker(['compose', '-f', filePath, '-p', projectName, 'stop', ...recreate]);
    runDocker([
      'compose',
      '-f',
      filePath,
      '-p',
      projectName,
      'up',
      '-d',
      '--force-recreate',
      '--no-deps',
      ...recreate,
    ]);
  }
  runDocker([
    'compose',
    '-f',
    filePath,
    '-p',
    projectName,
    'up',
    '-d',
    '--no-recreate',
    '--remove-orphans',
  ]);

  const services = options.config.dockerServices.map((service) => service.name);
  options.log?.(`Started Docker project '${projectName}' (${services.join(', ')}).`);
  return { projectName, services, serviceHashes };
}

function listDockerResourceIds(args: readonly string[]): string[] {
  const output = runDocker(args);
  if (!output) {
    return [];
  }
  return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

export function removeDockerServices(
  mainRoot: string,
  slot: number,
  log?: (message: string) => void,
): boolean {
  const projectName = getDockerProjectName(mainRoot, slot);
  const containerIds = listDockerResourceIds([
    'ps',
    '-a',
    '-q',
    '--filter',
    `label=${DOCKER_LABEL_PREFIX}.repo-root=${mainRoot}`,
    '--filter',
    `label=${DOCKER_LABEL_PREFIX}.slot=${slot}`,
    '--filter',
    `label=${DOCKER_LABEL_PREFIX}.managed=true`,
  ]);

  if (containerIds.length > 0) {
    runDocker(['rm', '-f', ...containerIds]);
  }

  const networkIds = listDockerResourceIds([
    'network',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${projectName}`,
  ]);
  if (networkIds.length > 0) {
    runDocker(['network', 'rm', ...networkIds]);
  }

  const removed = containerIds.length > 0 || networkIds.length > 0;
  if (removed) {
    log?.(`Removed Docker project '${projectName}'.`);
  } else {
    log?.(`Skipping Docker cleanup; no resources found for project '${projectName}'.`);
  }
  return removed;
}

export function listManagedDockerProjectsForRepo(mainRoot: string): ManagedDockerProjectSummary[] {
  let names: string[];
  try {
    names = listDockerResourceIds([
      'ps',
      '-a',
      '--filter',
      `label=${DOCKER_LABEL_PREFIX}.repo-root=${mainRoot}`,
      '--filter',
      `label=${DOCKER_LABEL_PREFIX}.managed=true`,
      '--format',
      '{{.Names}}',
    ]);
  } catch (err) {
    if (err instanceof Error && /Docker CLI not found|Cannot connect to the Docker daemon/i.test(err.message)) {
      return [];
    }
    throw err;
  }

  const projects = new Map<string, {
    slot: number;
    branch?: string;
    worktreePath?: string;
    services: Set<string>;
    containerNames: string[];
  }>();

  for (const name of names) {
    const inspect = inspectDockerContainer(name);
    if (!inspect) {
      continue;
    }
    const labels = inspect.Config?.Labels ?? {};
    const slotLabel = labels[`${DOCKER_LABEL_PREFIX}.slot`];
    if (!slotLabel) {
      continue;
    }
    const slot = Number.parseInt(slotLabel, 10);
    if (!Number.isSafeInteger(slot)) {
      continue;
    }
    const projectName = labels[`${DOCKER_LABEL_PREFIX}.project`] ?? getDockerProjectName(mainRoot, slot);
    const existing = projects.get(projectName) ?? {
      slot,
      branch: labels[`${DOCKER_LABEL_PREFIX}.branch`],
      worktreePath: labels[`${DOCKER_LABEL_PREFIX}.worktree`],
      services: new Set<string>(),
      containerNames: [],
    };
    const serviceName = labels[`${DOCKER_LABEL_PREFIX}.service`];
    if (serviceName) {
      existing.services.add(serviceName);
    }
    existing.containerNames.push(name);
    projects.set(projectName, existing);
  }

  return Array.from(projects.entries())
    .map(([projectName, project]) => ({
      projectName,
      slot: project.slot,
      branch: project.branch,
      worktreePath: project.worktreePath,
      services: Array.from(project.services).sort(),
      containerNames: project.containerNames.sort(),
    }))
    .sort((a, b) => a.slot - b.slot || a.projectName.localeCompare(b.projectName));
}
