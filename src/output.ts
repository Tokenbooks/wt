import * as fs from 'node:fs';
import type { Allocation, CliResult } from './types';

/** Format a CliResult as JSON string */
export function formatJson<T>(result: CliResult<T>): string {
  return JSON.stringify(result, null, 2);
}

/** Build a success result */
export function success<T>(data: T): CliResult<T> {
  return { success: true, data };
}

/** Build an error result */
export function error(code: string, message: string): CliResult {
  return { success: false, error: { code, message } };
}

/** Format allocation list as a human-readable table */
export function formatAllocationTable(
  allocations: Record<string, Allocation>,
): string {
  const entries = Object.entries(allocations);
  if (entries.length === 0) {
    return 'No worktree allocations found.';
  }

  const header = padRow(['Slot', 'Branch', 'DB', 'Redis', 'Ports', 'Status']);
  const separator = '-'.repeat(header.length);
  const rows = entries.map(([slot, alloc]) => {
    const portStr = Object.entries(alloc.ports)
      .map(([name, port]) => `${name}:${port}`)
      .join(' ');
    const status = fs.existsSync(alloc.worktreePath) ? 'ok' : 'stale';
    return padRow([slot, alloc.branchName, alloc.dbName, String(alloc.redisDb), portStr, status]);
  });

  return [header, separator, ...rows].join('\n');
}

/** Pad columns to fixed widths for table output */
function padRow(cols: string[]): string {
  const widths = [6, 30, 20, 7, 35, 8];
  return cols.map((col, i) => col.padEnd(widths[i] ?? 10)).join('');
}

/** Print a setup summary for human output */
export function formatSetupSummary(slot: number, alloc: Allocation): string {
  const portLines = Object.entries(alloc.ports)
    .map(([name, port]) => `  ${name}: ${port}`)
    .join('\n');

  return [
    `Worktree configured (slot ${slot}):`,
    `  Branch:   ${alloc.branchName}`,
    `  Database: ${alloc.dbName}`,
    `  Redis DB: ${alloc.redisDb}`,
    `  Ports:`,
    portLines,
    `  Path:     ${alloc.worktreePath}`,
  ].join('\n');
}
