import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRegistry, writeRegistry, removeAllocation, findByPath } from '../core/registry';
import { dropDatabase } from '../core/database';
import {
  getMainWorktreePath,
  listPrunableWorktrees,
  pruneWorktrees,
} from '../core/git';
import {
  listManagedDockerProjectsForRepo,
  removeDockerServices,
  usesDockerServices,
  type ManagedDockerProjectSummary,
} from '../core/docker-services';
import { loadConfig } from './setup';
import { extractErrorMessage, formatJson, success, error } from '../output';
import type { Allocation } from '../types';

interface PruneOptions {
  readonly json: boolean;
  readonly keepDb: boolean;
  readonly dryRun: boolean;
}

type PrunableReasonSource = 'git' | 'missing-path';

interface PrunableManagedAllocation {
  readonly slot: number;
  readonly allocation: Allocation;
  readonly reason: string;
  readonly reasonSource: PrunableReasonSource;
}

interface PrunedManagedWorktree {
  readonly slot: number;
  readonly worktreePath: string;
  readonly dbName: string;
  readonly dbDropped: boolean;
  readonly dockerRemoved: boolean;
  readonly reason: string;
  readonly reasonSource: PrunableReasonSource;
}

interface PrunedUnmanagedWorktree {
  readonly worktreePath: string;
  readonly reason: string;
}

interface PrunedOrphanDockerProject {
  readonly slot: number;
  readonly projectName: string;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly services: string[];
  readonly containerNames: string[];
  readonly removed: boolean;
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

/**
 * Prune stale worktrees and clean up wt-managed resources.
 *
 * Covers three independent leak sources:
 * 1. Git-prunable worktrees (disk entry missing but Git still tracks it).
 * 2. Registry allocations whose worktreePath no longer exists on disk — these
 *    can survive step 1 when Git itself has already been pruned.
 * 3. Managed Docker projects labeled for this repo whose slot is no longer
 *    in the registry — leftovers from partially-failed `wt new` runs or from
 *    worktrees cleaned up by something other than `wt remove`.
 */
export async function pruneCommand(options: PruneOptions): Promise<void> {
  const log = options.json
    ? () => {}
    : (message: string) => process.stderr.write(`${message}\n`);

  try {
    const mainRoot = getMainWorktreePath();
    const config = loadConfig(mainRoot);
    let registry = readRegistry(mainRoot);
    const gitPrunable = listPrunableWorktrees();

    const managed: PrunableManagedAllocation[] = [];
    const unmanaged: PrunedUnmanagedWorktree[] = [];
    const seenSlots = new Set<number>();

    for (const entry of gitPrunable) {
      const found = findByPath(registry, entry.path);
      if (!found) {
        unmanaged.push({ worktreePath: entry.path, reason: entry.reason });
        continue;
      }

      managed.push({
        slot: found[0],
        allocation: found[1],
        reason: entry.reason,
        reasonSource: 'git',
      });
      seenSlots.add(found[0]);
    }

    for (const [slotStr, allocation] of Object.entries(registry.allocations)) {
      const slot = Number(slotStr);
      if (seenSlots.has(slot)) {
        continue;
      }
      if (!fs.existsSync(allocation.worktreePath)) {
        managed.push({
          slot,
          allocation,
          reason: `worktree path does not exist on disk: ${allocation.worktreePath}`,
          reasonSource: 'missing-path',
        });
        seenSlots.add(slot);
      }
    }

    const activeSlots = new Set(
      Object.keys(registry.allocations).map((slotStr) => Number(slotStr)),
    );
    const orphanDockerProjects: ManagedDockerProjectSummary[] = listManagedDockerProjectsForRepo(mainRoot)
      .filter((project) => !activeSlots.has(project.slot));

    const nothingToDo =
      managed.length === 0 && unmanaged.length === 0 && orphanDockerProjects.length === 0;

    if (options.dryRun) {
      const payload = {
        prunableCount: gitPrunable.length,
        managed,
        unmanaged,
        orphanDockerProjects,
      };
      if (options.json) {
        console.log(formatJson(success(payload)));
        return;
      }
      if (nothingToDo) {
        console.log('Nothing to prune.');
        return;
      }
      const totalActions = managed.length + unmanaged.length + orphanDockerProjects.length;
      console.log(`Would prune ${totalActions} item${totalActions === 1 ? '' : 's'}:`);
      for (const item of managed) {
        console.log(`  Slot ${item.slot}: ${item.allocation.worktreePath}`);
        console.log(`    Reason: ${item.reason}`);
        console.log(`    Database: ${item.allocation.dbName}${options.keepDb ? ' (kept)' : ' (dropped)'}`);
        if (item.allocation.docker) {
          console.log(`    Docker: ${item.allocation.docker.projectName} (removed)`);
        }
      }
      for (const item of unmanaged) {
        console.log(`  Unmanaged: ${item.worktreePath}`);
        console.log(`    Reason: ${item.reason}`);
      }
      for (const orphan of orphanDockerProjects) {
        console.log(`  Orphan Docker: ${orphan.projectName} (slot ${orphan.slot})`);
        if (orphan.branch) {
          console.log(`    Branch: ${orphan.branch}`);
        }
        if (orphan.worktreePath) {
          console.log(`    Worktree: ${orphan.worktreePath}`);
        }
        if (orphan.services.length > 0) {
          console.log(`    Services: ${orphan.services.join(', ')}`);
        }
      }
      return;
    }

    if (nothingToDo) {
      const empty = {
        prunedManaged: [],
        prunedUnmanaged: [],
        prunedOrphanDockerProjects: [],
        failed: [],
      };
      if (options.json) {
        console.log(formatJson(success(empty)));
      } else {
        console.log('Nothing to prune.');
      }
      return;
    }

    const dbContext = options.keepDb || managed.length === 0
      ? null
      : {
        databaseUrl: readDatabaseUrl(mainRoot),
        baseDatabaseName: config.baseDatabaseName,
      };

    const prunedManaged: PrunedManagedWorktree[] = [];
    const prunedOrphans: PrunedOrphanDockerProject[] = [];
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

        const dockerRemoved = item.allocation.docker !== undefined || usesDockerServices(config)
          ? removeDockerServices(mainRoot, item.slot, log)
          : false;

        registry = removeAllocation(registry, item.slot);
        prunedManaged.push({
          slot: item.slot,
          worktreePath: item.allocation.worktreePath,
          dbName: item.allocation.dbName,
          dbDropped: dbContext !== null,
          dockerRemoved,
          reason: item.reason,
          reasonSource: item.reasonSource,
        });
      } catch (err) {
        failed.push({
          worktreePath: item.allocation.worktreePath,
          message: extractErrorMessage(err),
        });
      }
    }

    for (const orphan of orphanDockerProjects) {
      try {
        const removed = removeDockerServices(mainRoot, orphan.slot, log);
        prunedOrphans.push({
          slot: orphan.slot,
          projectName: orphan.projectName,
          branch: orphan.branch,
          worktreePath: orphan.worktreePath,
          services: orphan.services,
          containerNames: orphan.containerNames,
          removed,
        });
      } catch (err) {
        failed.push({
          worktreePath: orphan.projectName,
          message: extractErrorMessage(err),
        });
      }
    }

    if (prunedManaged.length > 0) {
      writeRegistry(mainRoot, registry);
    }

    if (gitPrunable.length > 0) {
      pruneWorktrees((command) => log(`Running: ${command}`));
    }

    const payload = {
      prunedManaged,
      prunedUnmanaged: unmanaged,
      prunedOrphanDockerProjects: prunedOrphans,
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
              message: `Failed to clean up ${failed.length} target${failed.length === 1 ? '' : 's'}.`,
            },
          }),
        );
      }
      if (failed.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const totalPruned = prunedManaged.length + unmanaged.length + prunedOrphans.length;
    console.log(`Pruned ${totalPruned} item${totalPruned === 1 ? '' : 's'}.`);
    for (const item of prunedManaged) {
      console.log(`  Slot ${item.slot}: ${item.worktreePath}`);
      console.log(`    Reason: ${item.reason}`);
      console.log(`    Database: ${item.dbName} ${item.dbDropped ? '(dropped)' : '(kept)'}`);
      console.log(`    Docker: ${item.dockerRemoved ? '(removed)' : '(not found)'}`);
    }
    for (const item of unmanaged) {
      console.log(`  Unmanaged: ${item.worktreePath}`);
      console.log(`    Reason: ${item.reason}`);
    }
    for (const orphan of prunedOrphans) {
      console.log(`  Orphan Docker: ${orphan.projectName} (slot ${orphan.slot}) ${orphan.removed ? '(removed)' : '(not found)'}`);
      if (orphan.branch) {
        console.log(`    Branch: ${orphan.branch}`);
      }
      if (orphan.worktreePath) {
        console.log(`    Worktree: ${orphan.worktreePath}`);
      }
      if (orphan.services.length > 0) {
        console.log(`    Services: ${orphan.services.join(', ')}`);
      }
    }
    if (failed.length > 0) {
      console.error(`Failed to clean up ${failed.length} target${failed.length === 1 ? '' : 's'}:`);
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
