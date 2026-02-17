import { readRegistry } from '../core/registry';
import { getMainWorktreePath } from '../core/git';
import { createNewWorktree } from './new';
import { formatAllocationTable, formatJson, success, error } from '../output';

interface OpenOptions {
  readonly json: boolean;
  readonly install: boolean;
}

/** Open (or create) a worktree and print its path */
export async function openCommand(
  slotOrBranch: string,
  options: OpenOptions,
): Promise<void> {
  const log = options.json
    ? () => {}
    : (msg: string) => process.stderr.write(`${msg}\n`);

  try {
    const mainRoot = getMainWorktreePath();
    const registry = readRegistry(mainRoot);

    const asSlot = parseInt(slotOrBranch, 10);
    if (!isNaN(asSlot) && String(asSlot) === slotOrBranch) {
      // Slot lookup
      const allocation = registry.allocations[String(asSlot)];
      if (!allocation) {
        if (options.json) {
          console.log(formatJson(error('NOT_FOUND', `No allocation found for slot ${asSlot}.`)));
        } else {
          console.error(`No allocation found for slot ${asSlot}.\n`);
          console.error(formatAllocationTable(registry.allocations));
        }
        process.exitCode = 1;
        return;
      }
      log(`Opening slot ${asSlot} (${allocation.branchName})`);
      if (options.json) {
        console.log(formatJson(success({ slot: asSlot, ...allocation })));
      } else {
        console.log(allocation.worktreePath);
      }
      return;
    }

    // Branch lookup
    for (const [slotStr, allocation] of Object.entries(registry.allocations)) {
      if (allocation.branchName === slotOrBranch) {
        log(`Opening slot ${slotStr} (${allocation.branchName})`);
        if (options.json) {
          console.log(formatJson(success({ slot: Number(slotStr), ...allocation })));
        } else {
          console.log(allocation.worktreePath);
        }
        return;
      }
    }

    // Not found — create a new worktree
    log(`Branch '${slotOrBranch}' not found in registry, creating...`);
    const { slot, allocation } = await createNewWorktree(slotOrBranch, {
      install: options.install,
      quiet: options.json,
    });

    if (options.json) {
      console.log(formatJson(success({ slot, ...allocation })));
    } else {
      console.log(allocation.worktreePath);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(formatJson(error('OPEN_FAILED', message)));
    } else {
      console.error(`Failed to open worktree: ${message}`);
    }
    process.exitCode = 1;
  }
}
