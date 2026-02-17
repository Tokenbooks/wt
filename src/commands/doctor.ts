import * as fs from 'node:fs';
import * as path from 'node:path';
import { readRegistry, writeRegistry, removeAllocation } from '../core/registry';
import { databaseExists, dropDatabase, listDatabasesByPattern } from '../core/database';
import { getMainWorktreePath } from '../core/git';
import { loadConfig } from './setup';
import { formatJson, success, error } from '../output';

interface DoctorOptions {
  readonly json: boolean;
  readonly fix: boolean;
}

interface DiagnosticIssue {
  readonly type: 'stale_entry' | 'missing_db' | 'missing_env' | 'orphaned_db';
  readonly slot?: number;
  readonly detail: string;
  readonly fixed?: boolean;
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

/** Run diagnostics on the worktree registry and databases */
export async function doctorCommand(options: DoctorOptions): Promise<void> {
  try {
    const mainRoot = getMainWorktreePath();
    const config = loadConfig(mainRoot);
    let registry = readRegistry(mainRoot);
    const databaseUrl = readDatabaseUrl(mainRoot);
    const issues: DiagnosticIssue[] = [];

    // Check each allocation
    for (const [slotStr, allocation] of Object.entries(registry.allocations)) {
      const slot = Number(slotStr);

      // Check if worktree path exists
      if (!fs.existsSync(allocation.worktreePath)) {
        const issue: DiagnosticIssue = {
          type: 'stale_entry',
          slot,
          detail: `Path does not exist: ${allocation.worktreePath}`,
          fixed: options.fix,
        };
        issues.push(issue);
        if (options.fix) {
          registry = removeAllocation(registry, slot);
        }
      }

      // Check if database exists
      const dbOk = await databaseExists(databaseUrl, allocation.dbName);
      if (!dbOk) {
        issues.push({
          type: 'missing_db',
          slot,
          detail: `Database does not exist: ${allocation.dbName}`,
        });
      }

      // Check if env files exist in the worktree
      if (fs.existsSync(allocation.worktreePath)) {
        for (const envFile of config.envFiles) {
          const envPath = path.join(allocation.worktreePath, envFile.source);
          if (!fs.existsSync(envPath)) {
            issues.push({
              type: 'missing_env',
              slot,
              detail: `Missing env file: ${envFile.source}`,
            });
          }
        }
      }
    }

    // Detect orphaned databases
    const pattern = `${config.baseDatabaseName}_wt%`;
    const allDbs = await listDatabasesByPattern(databaseUrl, pattern);
    const registeredDbNames = new Set(
      Object.values(registry.allocations).map((a) => a.dbName),
    );
    for (const dbName of allDbs) {
      if (!registeredDbNames.has(dbName)) {
        const issue: DiagnosticIssue = {
          type: 'orphaned_db',
          detail: `Orphaned database: ${dbName}`,
          fixed: options.fix,
        };
        issues.push(issue);
        if (options.fix) {
          await dropDatabase(databaseUrl, dbName, config.baseDatabaseName);
        }
      }
    }

    // Save registry if fixes were applied
    if (options.fix) {
      writeRegistry(mainRoot, registry);
    }

    // Output
    const result = { issues, totalIssues: issues.length, fixed: options.fix };
    if (options.json) {
      console.log(formatJson(success(result)));
      return;
    }

    if (issues.length === 0) {
      console.log('All checks passed. No issues found.');
      return;
    }

    console.log(`Found ${issues.length} issue(s):\n`);
    for (const issue of issues) {
      const prefix = issue.fixed ? '[FIXED]' : '[ISSUE]';
      const slotInfo = issue.slot !== undefined ? ` (slot ${issue.slot})` : '';
      console.log(`  ${prefix} ${issue.type}${slotInfo}: ${issue.detail}`);
    }

    if (!options.fix && issues.some((i) => i.type === 'stale_entry' || i.type === 'orphaned_db')) {
      console.log('\nRun with --fix to auto-repair stale entries and orphaned databases.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(formatJson(error('DOCTOR_FAILED', message)));
    } else {
      console.error(`Doctor failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
