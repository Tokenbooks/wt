import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRegistry, writeRegistry, removeAllocation, findByPath } from '../core/registry';
import { dropDatabase } from '../core/database';
import {
  getMainWorktreePath,
  listPrunableWorktrees,
  pruneWorktrees,
} from '../core/git';
import { removeManagedRedisContainer } from '../core/managed-redis';
import { loadConfig } from './setup';
import { extractErrorMessage, formatJson, success, error } from '../output';
import type { Allocation } from '../types';

interface PruneOptions {
  readonly json: boolean;
  readonly keepDb: boolean;
  readonly dryRun: boolean;
}

interface PrunableManagedAllocation {
  readonly slot: number;
  readonly allocation: Allocation;
  readonly reason: string;
}

interface PrunedManagedWorktree {
  readonly slot: number;
  readonly worktreePath: string;
  readonly dbName: string;
  readonly dbDropped: boolean;
  readonly redisContainerRemoved: boolean;
  readonly reason: string;
}

interface PrunedUnmanagedWorktree {
  readonly worktreePath: string;
  readonly reason: string;
}

interface PruneFailure {
  readonly worktreePath: string;
  readonly message: string;
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

/** Prune Git-prunable worktrees and clean up wt-managed resources for matching slots. */
export async function pruneCommand(options: PruneOptions): Promise<void> {
  const log = options.json
    ? () => {}
    : (message: string) => process.stderr.write(`${message}\n`);

  try {
    const mainRoot = getMainWorktreePath();
    let registry = readRegistry(mainRoot);
    const prunable = listPrunableWorktrees();

    const managed: PrunableManagedAllocation[] = [];
    const unmanaged: PrunedUnmanagedWorktree[] = [];

    for (const entry of prunable) {
      const found = findByPath(registry, entry.path);
      if (!found) {
        unmanaged.push({ worktreePath: entry.path, reason: entry.reason });
        continue;
      }

      managed.push({
        slot: found[0],
        allocation: found[1],
        reason: entry.reason,
      });
    }

    const payloadBase = {
      prunableCount: prunable.length,
      managed,
      unmanaged,
    };

    if (options.dryRun) {
      if (options.json) {
        console.log(formatJson(success(payloadBase)));
      } else if (prunable.length === 0) {
        console.log('No Git-prunable worktrees found.');
      } else {
        console.log(`Would prune ${prunable.length} worktree entr${prunable.length === 1 ? 'y' : 'ies'}:`);
        for (const item of managed) {
          console.log(`  Slot ${item.slot}: ${item.allocation.worktreePath}`);
          console.log(`    Reason: ${item.reason}`);
          console.log(`    Database: ${item.allocation.dbName}${options.keepDb ? ' (kept)' : ' (dropped)'}`);
          if (item.allocation.redisContainerName) {
            console.log(`    Redis: ${item.allocation.redisContainerName} (removed)`);
          }
        }
        for (const item of unmanaged) {
          console.log(`  Unmanaged: ${item.worktreePath}`);
          console.log(`    Reason: ${item.reason}`);
        }
      }
      return;
    }

    if (prunable.length === 0) {
      if (options.json) {
        console.log(formatJson(success({
          prunedManaged: [],
          prunedUnmanaged: [],
          failed: [],
        })));
      } else {
        console.log('No Git-prunable worktrees found.');
      }
      return;
    }

    const config = !options.keepDb && managed.length > 0 ? loadConfig(mainRoot) : null;
    const dbContext = options.keepDb || managed.length === 0 || config === null
      ? null
      : {
        databaseUrl: readDatabaseUrl(mainRoot),
        baseDatabaseName: config.baseDatabaseName,
      };

    const prunedManaged: PrunedManagedWorktree[] = [];
    const failed: PruneFailure[] = [];

    for (const item of managed) {
      try {
        if (dbContext !== null) {
          await dropDatabase(
            dbContext.databaseUrl,
            item.allocation.dbName,
            dbContext.baseDatabaseName,
            (statement) => log(`Running SQL: ${statement}`),
          );
        } else {
          log(`Skipping database drop for '${item.allocation.dbName}' (${options.keepDb ? '--keep-db' : 'no config'}).`);
        }

        const redisContainerRemoved = item.allocation.redisContainerName !== undefined
          ? removeManagedRedisContainer(mainRoot, item.slot, log)
          : false;

        registry = removeAllocation(registry, item.slot);
        prunedManaged.push({
          slot: item.slot,
          worktreePath: item.allocation.worktreePath,
          dbName: item.allocation.dbName,
          dbDropped: dbContext !== null,
          redisContainerRemoved,
          reason: item.reason,
        });
      } catch (err) {
        const message = extractErrorMessage(err);
        failed.push({ worktreePath: item.allocation.worktreePath, message });
      }
    }

    if (prunedManaged.length > 0) {
      writeRegistry(mainRoot, registry);
    }

    pruneWorktrees((command) => log(`Running: ${command}`));

    const payload = {
      prunedManaged,
      prunedUnmanaged: unmanaged,
      failed,
    };

    if (options.json) {
      if (failed.length === 0) {
        console.log(formatJson(success(payload)));
      } else {
        console.log(
          formatJson({
            success: false,
            data: payload,
            error: {
              code: 'PRUNE_PARTIAL',
              message: `Failed to clean up ${failed.length} managed worktree entr${failed.length === 1 ? 'y' : 'ies'}.`,
            },
          }),
        );
      }
      return;
    }

    console.log(`Pruned ${prunable.length} Git worktree entr${prunable.length === 1 ? 'y' : 'ies'}.`);
    for (const item of prunedManaged) {
      console.log(`  Slot ${item.slot}: ${item.worktreePath}`);
      console.log(`    Reason: ${item.reason}`);
      console.log(`    Database: ${item.dbName} ${item.dbDropped ? '(dropped)' : '(kept)'}`);
      console.log(`    Redis: ${item.redisContainerRemoved ? '(removed)' : '(not found)'}`);
    }
    for (const item of unmanaged) {
      console.log(`  Unmanaged: ${item.worktreePath}`);
      console.log(`    Reason: ${item.reason}`);
    }
    if (failed.length > 0) {
      console.error(`Failed to clean up ${failed.length} managed worktree entr${failed.length === 1 ? 'y' : 'ies'}:`);
      for (const item of failed) {
        console.error(`  ${item.worktreePath}: ${item.message}`);
      }
      process.exitCode = 1;
    }
  } catch (err) {
    const message = extractErrorMessage(err);
    if (options.json) {
      console.log(formatJson(error('PRUNE_FAILED', message)));
    } else {
      console.error(`Prune failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
