import { getMainWorktreePath } from '../core/git';
import { readRegistry } from '../core/registry';
import {
  auditWorktrees,
  fetchBaseRef,
  loadPrStates,
  renderReport,
  resolveBaseRef,
  type WtSlot,
} from '../core/audit';
import { error, extractErrorMessage, formatJson, success } from '../output';
import type { Allocation } from '../types';

interface AuditOptions {
  readonly json: boolean;
  readonly fetch: boolean;
  readonly base?: string;
  readonly ignoreDirty: readonly string[];
}

/** Project the registry's allocations into the audit's slot shape, slot-ascending. */
function slotsFromRegistry(allocations: Record<string, Allocation>): WtSlot[] {
  return Object.entries(allocations)
    .map(([slot, alloc]) => ({
      slot: Number(slot),
      path: alloc.worktreePath,
      branch: alloc.branchName,
      dbName: alloc.dbName,
    }))
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Classify every wt-managed worktree by how its branch relates to the base ref
 * and print either a human report (with a copyable `wt remove`) or raw JSON.
 */
export function auditCommand(options: AuditOptions): void {
  try {
    const repoDir = getMainWorktreePath();
    const slots = slotsFromRegistry(readRegistry(repoDir).allocations);

    if (options.fetch && !options.base) {
      fetchBaseRef(repoDir);
    }
    const base = options.base ?? resolveBaseRef(repoDir);
    const prMap = loadPrStates(repoDir);

    const audits = auditWorktrees(slots, {
      repoDir,
      base,
      ignoreDirtyPaths: options.ignoreDirty,
      prMap,
    });

    if (options.json) {
      console.log(formatJson(success(audits)));
      return;
    }
    console.log(renderReport(audits, base));
  } catch (err) {
    const message = extractErrorMessage(err);
    if (options.json) {
      console.log(formatJson(error('AUDIT_FAILED', message)));
    } else {
      console.error(`Audit failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
