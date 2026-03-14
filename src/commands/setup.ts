import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { configSchema } from '../schemas/config.schema';
import { readRegistry, writeRegistry, addAllocation, findByPath } from '../core/registry';
import {
  calculatePorts,
  calculateDbName,
  findAvailablePortSafeSlot,
  findUnavailableServicePorts,
  validatePortPlan,
} from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists } from '../core/database';
import {
  ensureManagedRedisContainer,
  getAllocationServices,
  readManagedRedisSourceUrl,
  usesManagedRedis,
} from '../core/managed-redis';
import { getMainWorktreePath, isMainWorktree, getBranchName } from '../core/git';
import { formatJson, formatSetupSummary, success, error } from '../output';
import type { Allocation, WtConfig } from '../types';

interface SetupOptions {
  readonly json: boolean;
  readonly install: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPatchedEnvVar(
  mainRoot: string,
  source: string,
  varName: string,
): string | null {
  const envPath = path.join(mainRoot, source);
  if (!fs.existsSync(envPath)) {
    return null;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const match = content.match(new RegExp(`^${varName}=["']?([^"'\\n]+)`, 'm'));
  return match?.[1] ?? null;
}

function inferLegacyRedisDefaultPort(
  mainRoot: string,
  envFiles: readonly unknown[],
): number {
  for (const envFile of envFiles) {
    if (!isRecord(envFile) || typeof envFile.source !== 'string' || !Array.isArray(envFile.patches)) {
      continue;
    }

    for (const patch of envFile.patches) {
      if (!isRecord(patch) || patch.type !== 'redis' || typeof patch.var !== 'string') {
        continue;
      }

      const sourceUrl = readPatchedEnvVar(mainRoot, envFile.source, patch.var);
      if (!sourceUrl) {
        continue;
      }

      try {
        const parsed = new URL(sourceUrl);
        return Number(parsed.port) || 6379;
      } catch {
        return 6379;
      }
    }
  }

  return 6379;
}

function migrateLegacyConfig(
  mainRoot: string,
  raw: unknown,
): { readonly config: unknown; readonly migrated: boolean } {
  if (!isRecord(raw)) {
    return { config: raw, migrated: false };
  }

  const next = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const envFiles = Array.isArray(next.envFiles) ? next.envFiles : [];
  const services = Array.isArray(next.services) ? [...next.services] : [];
  const redisServiceNames = new Set<string>();
  let migrated = false;

  for (const envFile of envFiles) {
    if (!isRecord(envFile) || !Array.isArray(envFile.patches)) {
      continue;
    }

    for (const patch of envFile.patches) {
      if (!isRecord(patch) || patch.type !== 'redis') {
        continue;
      }

      const serviceName = typeof patch.service === 'string' && patch.service.length > 0
        ? patch.service
        : 'redis';

      if (patch.service !== serviceName) {
        patch.service = serviceName;
        migrated = true;
      }

      redisServiceNames.add(serviceName);
    }
  }

  if (redisServiceNames.size > 0) {
    const declaredServiceNames = new Set(
      services
        .filter(isRecord)
        .map((service) => (typeof service.name === 'string' ? service.name : null))
        .filter((name): name is string => name !== null),
    );
    const inferredRedisPort = inferLegacyRedisDefaultPort(mainRoot, envFiles);

    for (const serviceName of redisServiceNames) {
      if (declaredServiceNames.has(serviceName)) {
        continue;
      }

      services.push({
        name: serviceName,
        defaultPort: inferredRedisPort,
      });
      declaredServiceNames.add(serviceName);
      migrated = true;
    }
  }

  if (migrated) {
    next.services = services;
  }

  return { config: next, migrated };
}

function validateConfig(config: WtConfig): WtConfig {
  const services = getAllocationServices(config);
  const seenServiceNames = new Set<string>();
  for (const service of services) {
    if (seenServiceNames.has(service.name)) {
      throw new Error(`Duplicate service name in wt.config.json: ${service.name}`);
    }
    seenServiceNames.add(service.name);
  }

  for (const envFile of config.envFiles) {
    for (const patch of envFile.patches) {
      if ('service' in patch && !seenServiceNames.has(patch.service)) {
        throw new Error(
          `Patch '${patch.var}' references unknown service '${patch.service}'.`,
        );
      }

      if (patch.type === 'redis' && patch.service !== 'redis') {
        throw new Error(
          `Redis patch '${patch.var}' must use service name 'redis', got '${patch.service}'.`,
        );
      }
    }
  }

  validatePortPlan(services, config.maxSlots, config.portStride);
  return config;
}

/** Load and validate wt.config.json from the main worktree */
export function loadConfig(mainRoot: string): WtConfig {
  const configPath = path.join(mainRoot, 'wt.config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  const { config, migrated } = migrateLegacyConfig(mainRoot, raw);

  if (migrated) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  return validateConfig(configSchema.parse(config));
}

/**
 * Read DATABASE_URL from the main worktree's .env file.
 * Used to connect to Postgres for admin operations.
 */
function readDatabaseUrl(mainRoot: string): string {
  const envPath = path.join(mainRoot, '.env');
  const content = fs.readFileSync(envPath, 'utf-8');
  const match = content.match(/^DATABASE_URL=["']?([^"'\n]+)/m);
  if (!match?.[1]) {
    throw new Error('DATABASE_URL not found in .env');
  }
  return match[1];
}

/** Set up an existing worktree with isolated DB, Redis, ports, and env files */
export async function setupCommand(
  targetPath: string | undefined,
  options: SetupOptions,
): Promise<void> {
  try {
    const worktreePath = path.resolve(targetPath ?? process.cwd());
    const mainRoot = getMainWorktreePath();

    if (isMainWorktree(worktreePath)) {
      const msg = 'Cannot setup the main worktree. Use this on secondary worktrees.';
      if (options.json) {
        console.log(formatJson(error('MAIN_WORKTREE', msg)));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }

    const config = loadConfig(mainRoot);
    const services = getAllocationServices(config);
    let registry = readRegistry(mainRoot);

    // Reuse existing allocation or allocate a new slot
    const existing = findByPath(registry, worktreePath);
    let slot: number;
    if (existing) {
      slot = existing[0];
    } else {
      const available = await findAvailablePortSafeSlot(
        registry,
        config.maxSlots,
        services,
        config.portStride,
      );
      if (available === null) {
        const msg =
          `All ${config.maxSlots} slots are occupied or blocked by ports already in use. ` +
          'Remove a worktree, stop conflicting services, or increase maxSlots.';
        if (options.json) {
          console.log(formatJson(error('NO_SLOTS', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
      slot = available;
    }

    const dbName = calculateDbName(slot, config.baseDatabaseName);
    const ports = calculatePorts(slot, services, config.portStride);
    if (!existing) {
      const unavailablePorts = await findUnavailableServicePorts(ports);
      if (unavailablePorts.length > 0) {
        const detail = unavailablePorts
          .map(({ service, port }) => `${service}:${port}`)
          .join(', ');
        throw new Error(`Slot ${slot} has ports already in use: ${detail}`);
      }
    }
    const branchName = getBranchName(worktreePath);
    const redisSourceUrl = usesManagedRedis(config)
      ? readManagedRedisSourceUrl(mainRoot, config)
      : null;
    const redisContainerName = usesManagedRedis(config)
      ? ensureManagedRedisContainer({
        mainRoot,
        slot,
        branchName,
        worktreePath,
        port: ports.redis!,
        sourceUrl: redisSourceUrl,
      })
      : undefined;

    // Create database if it doesn't exist
    const databaseUrl = readDatabaseUrl(mainRoot);
    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      await createDatabase(databaseUrl, config.baseDatabaseName, dbName);
    }

    // Copy and patch env files
    copyAndPatchAllEnvFiles(config, mainRoot, worktreePath, {
      dbName,
      redisPort: ports.redis,
      ports,
      branchName,
    });

    // Update registry
    const allocation: Allocation = {
      worktreePath,
      branchName,
      dbName,
      redisContainerName,
      ports,
      createdAt: new Date().toISOString(),
    };
    registry = addAllocation(registry, slot, allocation);
    writeRegistry(mainRoot, registry);

    // Run post-setup commands
    if (config.autoInstall && options.install && config.postSetup.length > 0) {
      for (const cmd of config.postSetup) {
        console.log(`Running: ${cmd}`);
        execSync(cmd, { cwd: worktreePath, stdio: 'inherit' });
      }
    }

    if (options.json) {
      console.log(formatJson(success({ slot, ...allocation })));
    } else {
      console.log(formatSetupSummary(slot, allocation));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(formatJson(error('SETUP_FAILED', message)));
    } else {
      console.error(`Setup failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
