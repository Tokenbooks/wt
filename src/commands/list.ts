import { readRegistry } from '../core/registry';
import { formatAllocationTable, formatJson, success } from '../output';

interface ListOptions {
  readonly json: boolean;
}

/** List all worktree allocations */
export function listCommand(repoRoot: string, options: ListOptions): void {
  const registry = readRegistry(repoRoot);

  if (options.json) {
    console.log(formatJson(success(registry.allocations)));
    return;
  }

  console.log(formatAllocationTable(registry.allocations));
}
