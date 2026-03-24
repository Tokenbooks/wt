import * as path from 'node:path';
import { readRegistry, writeRegistry, addAllocation } from '../core/registry';
import {
  calculatePorts,
  calculateDbName,
  findAvailablePortSafeSlot,
  findUnavailableServicePorts,
} from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists } from '../core/database';
import {
  ensureManagedRedisContainer,
  getAllocationServices,
  readManagedRedisSourceUrl,
  usesManagedRedis,
} from '../core/managed-redis';
import { getMainWorktreePath, createWorktree, getBranchName } from '../core/git';
import { extractErrorMessage, formatJson, formatSetupSummary, success, error } from '../output';
import { loadConfig } from './setup';
import type { Allocation } from '../types';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

interface NewOptions {
  readonly json: boolean;
  readonly install: boolean;
  readonly slot?: string;
}

export interface CreateWorktreeResult {
  slot: number;
  allocation: Allocation;
}

/** Read DATABASE_URL from the main worktree's .env file */
function readDatabaseUrl(mainRoot: string): string {
  const envPath = path.join(mainRoot, '.env');
  const content = fs.readFileSync(envPath, 'utf-8');
  const match = content.match(/^DATABASE_URL=["']?([^"'\n]+)/m);
  if (!match?.[1]) {
    throw new Error('DATABASE_URL not found in .env');
  }
  return match[1];
}

/** Core worktree creation logic — returns the result for programmatic use */
export async function createNewWorktree(
  branchName: string,
  options: { install: boolean; slot?: string; quiet?: boolean },
): Promise<CreateWorktreeResult> {
  const log = options.quiet
    ? () => {}
    : (msg: string) => process.stderr.write(`${msg}\n`);

  const mainRoot = getMainWorktreePath();
  const config = loadConfig(mainRoot);
  const services = getAllocationServices(config);
  let registry = readRegistry(mainRoot);

  // Determine slot
  let slot: number;
  if (options.slot !== undefined) {
    slot = parseInt(options.slot, 10);
    if (isNaN(slot) || slot < 1 || slot > config.maxSlots) {
      throw new Error(`Invalid slot: ${options.slot}. Must be 1-${config.maxSlots}.`);
    }
    if (String(slot) in registry.allocations) {
      throw new Error(`Slot ${slot} is already occupied.`);
    }
    const requestedPorts = calculatePorts(slot, services, config.portStride);
    const unavailablePorts = await findUnavailableServicePorts(requestedPorts);
    if (unavailablePorts.length > 0) {
      const detail = unavailablePorts
        .map(({ service, port }) => `${service}:${port}`)
        .join(', ');
      throw new Error(`Slot ${slot} has ports already in use: ${detail}`);
    }
  } else {
    const available = await findAvailablePortSafeSlot(
      registry,
      config.maxSlots,
      services,
      config.portStride,
    );
    if (available === null) {
      throw new Error(
        `All ${config.maxSlots} slots are occupied or blocked by ports already in use. ` +
        'Remove a worktree, stop conflicting services, or increase maxSlots.',
      );
    }
    slot = available;
  }

  log(`Creating worktree for '${branchName}' in slot ${slot}...`);

  // Create worktree
  const basePath = path.join(mainRoot, config.baseWorktreePath);
  const worktreePath = createWorktree(
    basePath,
    branchName,
    (command) => log(`Running: ${command}`),
  );
  const actualBranch = getBranchName(worktreePath);

  // Compute isolation params
  const dbName = calculateDbName(slot, config.baseDatabaseName);
  const ports = calculatePorts(slot, services, config.portStride);
  const redisSourceUrl = usesManagedRedis(config)
    ? readManagedRedisSourceUrl(mainRoot, config)
    : null;
  const redisContainerName = usesManagedRedis(config)
    ? ensureManagedRedisContainer({
      mainRoot,
      slot,
      branchName: actualBranch,
      worktreePath,
      port: ports.redis!,
      sourceUrl: redisSourceUrl,
      log,
    })
    : undefined;

  // Create database
  const databaseUrl = readDatabaseUrl(mainRoot);
  const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
  if (!dbAlreadyExists) {
    log(`Creating database '${dbName}'...`);
    await createDatabase(
      databaseUrl,
      config.baseDatabaseName,
      dbName,
      (statement) => log(`Running SQL: ${statement}`),
    );
  } else {
    log(`Database '${dbName}' already exists, reusing.`);
  }

  // Copy and patch env files
  log(`Patching ${config.envFiles.length} env file(s)...`);
  copyAndPatchAllEnvFiles(config, mainRoot, worktreePath, {
    dbName,
    redisPort: ports.redis,
    ports,
    branchName: actualBranch,
  });

  // Update registry
  const allocation: Allocation = {
    worktreePath,
    branchName: actualBranch,
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
      log(`Running: ${cmd}`);
      execSync(cmd, { cwd: worktreePath, stdio: 'inherit' });
    }
  }

  log(`Ready — slot ${slot}, branch '${actualBranch}'.`);
  return { slot, allocation };
}

/** Create a new worktree with full environment isolation */
export async function newCommand(
  branchName: string,
  options: NewOptions,
): Promise<void> {
  try {
    const { slot, allocation } = await createNewWorktree(branchName, {
      ...options,
      quiet: options.json,
    });

    if (options.json) {
      console.log(formatJson(success({ slot, ...allocation })));
    } else {
      console.log(formatSetupSummary(slot, allocation));
    }
  } catch (err) {
    const message = extractErrorMessage(err);
    if (options.json) {
      console.log(formatJson(error('NEW_FAILED', message)));
    } else {
      console.error(`Failed to create worktree: ${message}`);
    }
    process.exitCode = 1;
  }
}
