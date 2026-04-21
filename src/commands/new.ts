import * as path from 'node:path';
import { readRegistry, writeRegistry, addAllocation } from '../core/registry';
import {
  calculatePorts,
  calculateDbName,
  findAvailablePortSafeSlot,
  findUnavailableServicePorts,
} from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists, dropDatabase } from '../core/database';
import {
  ensureManagedRedisContainer,
  getAllocationServices,
  readManagedRedisSourceUrl,
  removeManagedRedisContainer,
  usesManagedRedis,
} from '../core/managed-redis';
import {
  getMainWorktreePath,
  createWorktree,
  getBranchName,
  removeWorktree,
  resolveWorktreeBranch,
  type WorktreeBranchSelection,
} from '../core/git';
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
  readonly slot: number;
  readonly allocation: Allocation;
  readonly branchSelection: WorktreeBranchSelection;
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
  const warn = (msg: string) => process.stderr.write(`${msg}\n`);

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

  const basePath = path.join(mainRoot, config.baseWorktreePath);
  const branchSelection = resolveWorktreeBranch(
    branchName,
    (command) => log(`Running: ${command}`),
  );
  if (branchSelection.originCheckError) {
    warn(`Failed to check origin for '${branchName}': ${branchSelection.originCheckError}`);
  }
  log(describeBranchSelection(branchSelection));

  const dbName = calculateDbName(slot, config.baseDatabaseName);
  const ports = calculatePorts(slot, services, config.portStride);
  const databaseUrl = readDatabaseUrl(mainRoot);
  const managedRedis = usesManagedRedis(config);

  // Track what each step has created so we can roll back on failure. Resource
  // leaks from partially-successful `wt new` runs were the main source of
  // orphan Redis containers in practice — everything allocated here must be
  // torn down if we fail before writing the registry.
  let worktreeCreated = false;
  let redisContainerCreated = false;
  let databaseCreated = false;
  let worktreePath: string;
  let actualBranch: string;
  let allocation: Allocation;
  let redisContainerName: string | undefined;

  try {
    worktreePath = createWorktree(
      basePath,
      branchSelection,
      (command) => log(`Running: ${command}`),
    );
    worktreeCreated = true;
    actualBranch = getBranchName(worktreePath);

    if (managedRedis) {
      const redisSourceUrl = readManagedRedisSourceUrl(mainRoot, config);
      redisContainerName = ensureManagedRedisContainer({
        mainRoot,
        slot,
        branchName: actualBranch,
        worktreePath,
        port: ports.redis!,
        sourceUrl: redisSourceUrl,
        log,
      });
      redisContainerCreated = true;
    }

    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      log(`Creating database '${dbName}'...`);
      await createDatabase(
        databaseUrl,
        config.baseDatabaseName,
        dbName,
        (statement) => log(`Running SQL: ${statement}`),
      );
      databaseCreated = true;
    } else {
      log(`Database '${dbName}' already exists, reusing.`);
    }

    log(`Patching ${config.envFiles.length} env file(s)...`);
    copyAndPatchAllEnvFiles(config, mainRoot, worktreePath, {
      dbName,
      redisPort: ports.redis,
      ports,
      branchName: actualBranch,
    });

    allocation = {
      worktreePath,
      branchName: actualBranch,
      dbName,
      redisContainerName,
      ports,
      createdAt: new Date().toISOString(),
    };
    registry = addAllocation(registry, slot, allocation);
    writeRegistry(mainRoot, registry);
  } catch (err) {
    const reason = extractErrorMessage(err);
    warn(`Failed to create worktree for '${branchName}' in slot ${slot}: ${reason}`);
    warn('Rolling back partial setup...');

    if (databaseCreated) {
      try {
        await dropDatabase(
          databaseUrl,
          dbName,
          config.baseDatabaseName,
          (statement) => log(`Rollback SQL: ${statement}`),
        );
        log(`Rollback: dropped database '${dbName}'.`);
      } catch (rollbackErr) {
        warn(`Rollback failed to drop database '${dbName}': ${extractErrorMessage(rollbackErr)}`);
      }
    }

    if (redisContainerCreated) {
      try {
        removeManagedRedisContainer(mainRoot, slot, log);
      } catch (rollbackErr) {
        warn(`Rollback failed to remove Redis container for slot ${slot}: ${extractErrorMessage(rollbackErr)}`);
      }
    }

    if (worktreeCreated && worktreePath! && fs.existsSync(worktreePath!)) {
      try {
        removeWorktree(worktreePath!, (command) => log(`Rollback: ${command}`));
        log(`Rollback: removed worktree at ${worktreePath!}.`);
      } catch (rollbackErr) {
        warn(`Rollback failed to remove worktree at ${worktreePath!}: ${extractErrorMessage(rollbackErr)}`);
      }
    }

    throw err;
  }

  // Run post-setup commands
  if (config.autoInstall && options.install && config.postSetup.length > 0) {
    for (const cmd of config.postSetup) {
      log(`Running: ${cmd}`);
      execSync(cmd, { cwd: worktreePath, stdio: 'inherit' });
    }
  }

  log(`Ready — slot ${slot}, branch '${actualBranch}'.`);
  return { slot, allocation, branchSelection };
}

/** Create a new worktree with full environment isolation */
export async function newCommand(
  branchName: string,
  options: NewOptions,
): Promise<void> {
  try {
    const { slot, allocation, branchSelection } = await createNewWorktree(branchName, {
      ...options,
      quiet: options.json,
    });

    if (options.json) {
      console.log(
        formatJson(
          success({
            slot,
            ...allocation,
            branchSource: branchSelection.source,
            branchSourceLabel: branchSelection.sourceLabel,
          }),
        ),
      );
    } else {
      console.log(
        formatSetupSummary(slot, allocation, {
          branchSourceLabel: branchSelection.sourceLabel,
        }),
      );
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

function describeBranchSelection(branchSelection: WorktreeBranchSelection): string {
  switch (branchSelection.source) {
    case 'origin':
      return `Using branch '${branchSelection.branchName}' from ${branchSelection.sourceLabel}.`;
    case 'local-existing':
      return `Using existing local branch '${branchSelection.branchName}'.`;
    case 'local-new':
      return `Using branch '${branchSelection.branchName}' as a fresh local branch.`;
  }
}
