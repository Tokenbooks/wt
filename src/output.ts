import * as fs from 'node:fs';
import type { Allocation, CliResult } from './types';

/** Extract a meaningful message from any error, including AggregateError and child-process errors. */
export function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err) || 'Unknown error';
  }

  // AggregateError (e.g. pg connection failure trying IPv4 + IPv6)
  if ('errors' in err && Array.isArray((err as { errors?: unknown[] }).errors)) {
    const inner = (err as { errors: unknown[] }).errors;
    const messages = inner
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .filter((m) => m.length > 0);
    if (messages.length > 0) {
      return messages.join('; ');
    }
  }

  if (err.message) {
    return err.message;
  }

  // execSync / execFileSync errors carry stderr
  if ('stderr' in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr) {
      return stderr;
    }
  }

  return String(err) || 'Unknown error';
}

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

  const header = padRow(['Slot', 'Branch', 'DB', 'Docker', 'Ports', 'Status']);
  const separator = '-'.repeat(header.length);
  const rows = entries.map(([slot, alloc]) => {
    const portStr = Object.entries(alloc.ports)
      .map(([name, port]) => `${name}:${port}`)
      .join(' ');
    const status = fs.existsSync(alloc.worktreePath) ? 'ok' : 'stale';
    return padRow([slot, alloc.branchName, alloc.dbName, formatDockerCell(alloc), portStr, status]);
  });

  return [header, separator, ...rows].join('\n');
}

/** Pad columns to fixed widths for table output */
function padRow(cols: string[]): string {
  const widths = [6, 30, 20, 18, 35, 8];
  return cols.map((col, i) => col.padEnd(widths[i] ?? 10)).join('');
}

function formatDockerCell(alloc: Allocation): string {
  if (!alloc.docker) {
    return '-';
  }
  return `${alloc.docker.projectName} (${alloc.docker.services.length})`;
}

/** Print a setup summary for human output */
export function formatSetupSummary(
  slot: number,
  alloc: Allocation,
  options?: { branchSourceLabel?: string },
): string {
  const portLines = Object.entries(alloc.ports)
    .map(([name, port]) => `  ${name}: ${port}`)
    .join('\n');

  return [
    `Worktree configured (slot ${slot}):`,
    `  Branch:   ${alloc.branchName}`,
    ...(options?.branchSourceLabel ? [`  Source:   ${options.branchSourceLabel}`] : []),
    `  Database: ${alloc.dbName}`,
    alloc.docker
      ? `  Docker:   ${alloc.docker.projectName} (${alloc.docker.services.join(', ')})`
      : '  Docker:   -',
    `  Ports:`,
    portLines,
    `  Path:     ${alloc.worktreePath}`,
  ].join('\n');
}
