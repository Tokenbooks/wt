import * as path from 'node:path';
import * as fs from 'node:fs';
import { readRegistry, writeRegistry, removeAllocation, findByPath } from '../core/registry';
import { dropDatabase } from '../core/database';
import { getMainWorktreePath, removeWorktree } from '../core/git';
import { loadConfig } from './setup';
import { formatJson, success, error } from '../output';

interface RemoveOptions {
  readonly json: boolean;
  readonly keepDb: boolean;
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

/** Remove a worktree, its database, and its registry entry */
export async function removeCommand(
  pathOrSlot: string,
  options: RemoveOptions,
): Promise<void> {
  try {
    const mainRoot = getMainWorktreePath();
    const config = loadConfig(mainRoot);
    let registry = readRegistry(mainRoot);

    // Find the allocation by slot number or path
    let slot: number;
    let worktreePath: string;
    let dbName: string;

    const asSlot = parseInt(pathOrSlot, 10);
    if (!isNaN(asSlot) && String(asSlot) === pathOrSlot) {
      // Looks like a slot number
      const allocation = registry.allocations[String(asSlot)];
      if (!allocation) {
        const msg = `No allocation found for slot ${asSlot}.`;
        if (options.json) {
          console.log(formatJson(error('NOT_FOUND', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
      slot = asSlot;
      worktreePath = allocation.worktreePath;
      dbName = allocation.dbName;
    } else {
      // Treat as a path
      const resolved = path.resolve(pathOrSlot);
      const found = findByPath(registry, resolved);
      if (!found) {
        const msg = `No allocation found for path: ${resolved}`;
        if (options.json) {
          console.log(formatJson(error('NOT_FOUND', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
      [slot, { worktreePath, dbName }] = [found[0], found[1]];
    }

    // Drop database
    if (!options.keepDb) {
      const databaseUrl = readDatabaseUrl(mainRoot);
      await dropDatabase(databaseUrl, dbName, config.baseDatabaseName);
    }

    // Remove git worktree (only if path still exists)
    if (fs.existsSync(worktreePath)) {
      removeWorktree(worktreePath);
    }

    // Update registry
    registry = removeAllocation(registry, slot);
    writeRegistry(mainRoot, registry);

    const result = { slot, worktreePath, dbName, dbDropped: !options.keepDb };
    if (options.json) {
      console.log(formatJson(success(result)));
    } else {
      console.log(`Removed worktree (slot ${slot}):`);
      console.log(`  Path:     ${worktreePath}`);
      console.log(`  Database: ${dbName} ${options.keepDb ? '(kept)' : '(dropped)'}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(formatJson(error('REMOVE_FAILED', message)));
    } else {
      console.error(`Failed to remove worktree: ${message}`);
    }
    process.exitCode = 1;
  }
}
