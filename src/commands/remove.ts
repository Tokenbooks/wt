import * as path from 'node:path';
import * as fs from 'node:fs';
import { readRegistry, writeRegistry, removeAllocation, findByPath } from '../core/registry';
import { dropDatabase } from '../core/database';
import { getMainWorktreePath, removeWorktree } from '../core/git';
import { loadConfig } from './setup';
import { formatJson, success, error } from '../output';
import type { Registry } from '../types';

interface RemoveOptions {
  readonly json: boolean;
  readonly keepDb: boolean;
  readonly all: boolean;
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

interface ResolvedTarget {
  readonly slot: number;
  readonly worktreePath: string;
  readonly dbName: string;
}

interface ResolvedTargetError {
  readonly error: string;
}

interface RemoveSuccess {
  readonly target: string;
  readonly slot: number;
  readonly worktreePath: string;
  readonly dbName: string;
  readonly dbDropped: boolean;
}

interface RemoveFailure {
  readonly target: string;
  readonly message: string;
}

/**
 * Parse raw CLI targets.
 *
 * Supports:
 * - `wt remove 1,2`
 * - `wt remove "1, 2"`
 * - `wt remove 1 2`
 */
export function parseRemoveTargets(rawTargets: readonly string[]): string[] {
  return rawTargets
    .flatMap((rawTarget) => rawTarget.split(','))
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
}

function parseSlotTarget(target: string): number | null {
  if (!/^\d+$/.test(target)) {
    return null;
  }
  const slot = Number.parseInt(target, 10);
  return Number.isSafeInteger(slot) ? slot : null;
}

function resolveTarget(
  registry: Registry,
  target: string,
): ResolvedTarget | ResolvedTargetError {
  const slot = parseSlotTarget(target);
  if (slot !== null) {
    const allocation = registry.allocations[String(slot)];
    if (!allocation) {
      return { error: `No allocation found for slot ${slot}.` };
    }
    return {
      slot,
      worktreePath: allocation.worktreePath,
      dbName: allocation.dbName,
    };
  }

  const resolvedPath = path.resolve(target);
  const found = findByPath(registry, resolvedPath);
  if (!found) {
    return { error: `No allocation found for path: ${resolvedPath}` };
  }
  return {
    slot: found[0],
    worktreePath: found[1].worktreePath,
    dbName: found[1].dbName,
  };
}

/** Remove one or more worktrees, their databases, and registry entries */
export async function removeCommand(
  rawTargets: readonly string[],
  options: RemoveOptions,
): Promise<void> {
  const log = options.json
    ? () => {}
    : (message: string) => process.stderr.write(`${message}\n`);

  try {
    const mainRoot = getMainWorktreePath();
    let registry = readRegistry(mainRoot);
    const parsedTargets = parseRemoveTargets(rawTargets);

    if (options.all && parsedTargets.length > 0) {
      const msg = 'Use either explicit targets or --all, not both.';
      if (options.json) {
        console.log(formatJson(error('INVALID_ARGS', msg)));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }

    let targets: string[];
    if (options.all) {
      targets = Object.keys(registry.allocations).sort((a, b) => Number(a) - Number(b));
      if (targets.length === 0) {
        const empty = { removed: [], failed: [] };
        if (options.json) {
          console.log(formatJson(success(empty)));
        } else {
          console.log('No worktree allocations found.');
        }
        return;
      }
      log(`Removing all allocations: ${targets.join(', ')}`);
    } else {
      targets = parsedTargets;
      if (targets.length === 0) {
        const msg = 'Provide at least one target or use --all.';
        if (options.json) {
          console.log(formatJson(error('MISSING_TARGET', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
    }

    const dbContext = options.keepDb
      ? null
      : {
        databaseUrl: readDatabaseUrl(mainRoot),
        baseDatabaseName: loadConfig(mainRoot).baseDatabaseName,
      };
    const seenSlots = new Set<number>();
    const removed: RemoveSuccess[] = [];
    const failed: RemoveFailure[] = [];

    for (const target of targets) {
      const resolved = resolveTarget(registry, target);
      if ('error' in resolved) {
        failed.push({ target, message: resolved.error });
        continue;
      }
      if (seenSlots.has(resolved.slot)) {
        continue;
      }
      seenSlots.add(resolved.slot);

      try {
        log(`Removing slot ${resolved.slot} (${resolved.worktreePath})`);

        if (dbContext !== null) {
          await dropDatabase(
            dbContext.databaseUrl,
            resolved.dbName,
            dbContext.baseDatabaseName,
            (statement) => log(`Running SQL: ${statement}`),
          );
        } else {
          log(`Skipping database drop for '${resolved.dbName}' (--keep-db).`);
        }

        if (fs.existsSync(resolved.worktreePath)) {
          removeWorktree(
            resolved.worktreePath,
            (command) => log(`Running: ${command}`),
          );
        } else {
          log(`Skipping git worktree remove; path not found: ${resolved.worktreePath}`);
        }

        registry = removeAllocation(registry, resolved.slot);
        removed.push({
          target,
          slot: resolved.slot,
          worktreePath: resolved.worktreePath,
          dbName: resolved.dbName,
          dbDropped: !options.keepDb,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ target, message });
      }
    }

    if (removed.length > 0) {
      writeRegistry(mainRoot, registry);
    }

    const payload = { removed, failed };
    if (options.json) {
      if (failed.length === 0) {
        console.log(formatJson(success(payload)));
      } else {
        console.log(
          formatJson({
            success: false,
            data: payload,
            error: {
              code: 'REMOVE_PARTIAL',
              message: `Failed to remove ${failed.length} target(s).`,
            },
          }),
        );
      }
    } else {
      if (removed.length > 0) {
        console.log(`Removed ${removed.length} worktree(s):`);
        for (const item of removed) {
          console.log(`  Slot ${item.slot}: ${item.worktreePath}`);
          console.log(`    Database: ${item.dbName} ${item.dbDropped ? '(dropped)' : '(kept)'}`);
        }
      }
      if (failed.length > 0) {
        console.error(`Failed to remove ${failed.length} target(s):`);
        for (const item of failed) {
          console.error(`  ${item.target}: ${item.message}`);
        }
      }
      if (removed.length === 0 && failed.length === 0) {
        console.log('No worktree allocations found.');
      }
    }

    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(formatJson(error('REMOVE_FAILED', message)));
    } else {
      console.error(`Failed to remove worktree(s): ${message}`);
    }
    process.exitCode = 1;
  }
}
