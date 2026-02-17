import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { configSchema } from '../schemas/config.schema';
import { readRegistry, writeRegistry, addAllocation, findByPath } from '../core/registry';
import { calculatePorts, calculateDbName, findAvailableSlot } from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists } from '../core/database';
import { getMainWorktreePath, isMainWorktree, getBranchName } from '../core/git';
import { formatJson, formatSetupSummary, success, error } from '../output';
import type { Allocation, WtConfig } from '../types';

interface SetupOptions {
  readonly json: boolean;
  readonly install: boolean;
}

/** Load and validate wt.config.json from the main worktree */
export function loadConfig(mainRoot: string): WtConfig {
  const configPath = path.join(mainRoot, 'wt.config.json');
  const raw = require(configPath);
  return configSchema.parse(raw);
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
    let registry = readRegistry(mainRoot);

    // Reuse existing allocation or allocate a new slot
    const existing = findByPath(registry, worktreePath);
    let slot: number;
    if (existing) {
      slot = existing[0];
    } else {
      const available = findAvailableSlot(registry, config.maxSlots);
      if (available === null) {
        const msg = `All ${config.maxSlots} slots are occupied. Remove a worktree first.`;
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
    const branchName = getBranchName(worktreePath);

    // Create database if it doesn't exist
    const databaseUrl = readDatabaseUrl(mainRoot);
    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      await createDatabase(databaseUrl, config.baseDatabaseName, dbName);
    }

    // Copy and patch env files
    copyAndPatchAllEnvFiles(config, mainRoot, worktreePath, {
      dbName,
      redisDb: slot,
      ports,
    });

    // Update registry
    const allocation: Allocation = {
      worktreePath,
      branchName,
      dbName,
      redisDb: slot,
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
