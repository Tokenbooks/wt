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
  ensureDockerServices,
} from '../core/docker-services';
import { getMainWorktreePath, isMainWorktree, getBranchName } from '../core/git';
import { extractErrorMessage, formatJson, formatSetupSummary, success, error } from '../output';
import type { Allocation, WtConfig } from '../types';

interface SetupOptions {
  readonly json: boolean;
  readonly install: boolean;
}

function validateConfig(config: WtConfig): WtConfig {
  const seenServiceNames = new Set<string>();
  for (const service of config.services) {
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
    }
  }

  const seenDockerServiceNames = new Set<string>();
  for (const dockerService of config.dockerServices) {
    if (seenDockerServiceNames.has(dockerService.name)) {
      throw new Error(`Duplicate docker service name in wt.config.json: ${dockerService.name}`);
    }
    seenDockerServiceNames.add(dockerService.name);

    for (const port of dockerService.ports) {
      if (!seenServiceNames.has(port.service)) {
        throw new Error(
          `Docker service '${dockerService.name}' references unknown port service '${port.service}'.`,
        );
      }
    }
  }

  validatePortPlan(config.services, config.maxSlots, config.portStride);
  return config;
}

/** Load and validate wt.config.json from the main worktree */
export function loadConfig(mainRoot: string): WtConfig {
  const configPath = path.join(mainRoot, 'wt.config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  return validateConfig(configSchema.parse(raw));
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

/** Set up an existing worktree with isolated DB, Docker services, ports, and env files */
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
        config.services,
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
    const ports = calculatePorts(slot, config.services, config.portStride);
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

    // Create database if it doesn't exist
    const databaseUrl = readDatabaseUrl(mainRoot);
    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      await createDatabase(databaseUrl, config.baseDatabaseName, dbName);
    }

    const docker = ensureDockerServices({
      mainRoot,
      slot,
      branchName,
      worktreePath,
      dbName,
      ports,
      config,
    });

    // Copy and patch env files
    copyAndPatchAllEnvFiles(config, mainRoot, worktreePath, {
      dbName,
      ports,
      branchName,
    });

    // Update registry
    const allocation: Allocation = {
      worktreePath,
      branchName,
      dbName,
      docker,
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
    const message = extractErrorMessage(err);
    if (options.json) {
      console.log(formatJson(error('SETUP_FAILED', message)));
    } else {
      console.error(`Setup failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
