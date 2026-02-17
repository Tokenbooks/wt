import * as path from 'node:path';
import { configSchema } from '../schemas/config.schema';
import { readRegistry, writeRegistry, addAllocation } from '../core/registry';
import { calculatePorts, calculateDbName, findAvailableSlot } from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists } from '../core/database';
import { getMainWorktreePath, createWorktree, getBranchName } from '../core/git';
import { formatJson, formatSetupSummary, success, error } from '../output';
import { loadConfig } from './setup';
import type { Allocation } from '../types';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

interface NewOptions {
  readonly json: boolean;
  readonly install: boolean;
  readonly slot?: string;
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

/** Create a new worktree with full environment isolation */
export async function newCommand(
  branchName: string,
  options: NewOptions,
): Promise<void> {
  try {
    const mainRoot = getMainWorktreePath();
    const config = loadConfig(mainRoot);
    let registry = readRegistry(mainRoot);

    // Determine slot
    let slot: number;
    if (options.slot !== undefined) {
      slot = parseInt(options.slot, 10);
      if (isNaN(slot) || slot < 1 || slot > config.maxSlots) {
        const msg = `Invalid slot: ${options.slot}. Must be 1-${config.maxSlots}.`;
        if (options.json) {
          console.log(formatJson(error('INVALID_SLOT', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
      if (String(slot) in registry.allocations) {
        const msg = `Slot ${slot} is already occupied.`;
        if (options.json) {
          console.log(formatJson(error('SLOT_OCCUPIED', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
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

    // Create worktree
    const basePath = path.join(mainRoot, config.baseWorktreePath);
    const worktreePath = createWorktree(basePath, branchName);
    const actualBranch = getBranchName(worktreePath);

    // Compute isolation params
    const dbName = calculateDbName(slot, config.baseDatabaseName);
    const ports = calculatePorts(slot, config.services, config.portStride);

    // Create database
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
      branchName: actualBranch,
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
      console.log(formatJson(error('NEW_FAILED', message)));
    } else {
      console.error(`Failed to create worktree: ${message}`);
    }
    process.exitCode = 1;
  }
}
