#!/usr/bin/env node

import { Command } from 'commander';
import { newCommand } from './commands/new';
import { setupCommand } from './commands/setup';
import { removeCommand } from './commands/remove';
import { pruneCommand } from './commands/prune';
import { listCommand } from './commands/list';
import { auditCommand } from './commands/audit';
import { doctorCommand } from './commands/doctor';
import { openCommand } from './commands/open';
import { envSeedCommand } from './commands/env';
import { getMainWorktreePath } from './core/git';
import { name, version } from '../package.json';
import { getUpdateNotice, refreshUpdateCache, isCacheFresh } from './core/update-check';

const program = new Command();

program
  .name('wt')
  .description('Git worktree environment isolation CLI')
  .version(version);

program
  .command('new')
  .description('Create a new worktree with isolated environment')
  .argument('[branch]', 'Branch to create or checkout; auto-generated from --base when omitted')
  .option('--slot <n>', 'Force a specific slot number')
  .option('--base <ref>', 'Start point for a newly created branch (branch/tag/commit); seeds the auto-name when [branch] is omitted; ignored if the branch already exists')
  .option('--no-install', 'Skip post-setup commands')
  .option('--json', 'Output as JSON', false)
  .addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  wt new feat/login                 # create/checkout feat/login (forks from HEAD if new)',
      '  wt new feat/login --base main     # new branch forked from main',
      '  wt new --base main                # throwaway branch e.g. main-20260723-nemanull off main',
      '  wt new                            # same, base defaults to origin/main then main',
      '',
    ].join('\n'),
  )
  .action(async (branch: string | undefined, opts) => {
    await newCommand(branch, {
      json: opts.json,
      install: opts.install,
      slot: opts.slot,
      base: opts.base,
    });
  });

program
  .command('setup')
  .description('Set up environment for an existing worktree')
  .argument('[path]', 'Worktree path (default: current directory)')
  .option('--no-install', 'Skip post-setup commands')
  .option('--json', 'Output as JSON', false)
  .option('--repair', 're-allocate ports for an existing worktree, treating its own current ports as not-reserved', false)
  .option('--dry-run', 'preview what --repair would change without writing', false)
  .action(async (targetPath: string | undefined, opts) => {
    await setupCommand(targetPath, {
      json: opts.json,
      install: opts.install,
      repair: opts.repair,
      dryRun: opts.dryRun,
    });
  });

program
  .command('env')
  .description('Manage local env files')
  .addCommand(
    new Command('seed')
      .description('Create configured env files from examples and fill missing vars')
      .argument('[path]', 'Repo or worktree path (default: current directory)')
      .option('--dry-run', 'Preview env file changes without writing', false)
      .option('--json', 'Output as JSON', false)
      .action((targetPath: string | undefined, opts) => {
        envSeedCommand(targetPath, {
          json: opts.json,
          dryRun: opts.dryRun,
        });
      }),
  );

program
  .command('open')
  .description('Open a worktree by slot or branch (creates if not found)')
  .argument('<slot-or-branch>', 'Slot number or branch name')
  .option('--no-install', 'Skip post-setup commands if creating')
  .option('--json', 'Output as JSON', false)
  .action(async (slotOrBranch: string, opts) => {
    await openCommand(slotOrBranch, {
      json: opts.json,
      install: opts.install,
    });
  });

program
  .command('remove')
  .description('Remove worktree(s) by target list, CSV slots, or --all')
  .argument('[targets...]', 'Worktree path(s) or slot number(s); supports comma-separated values')
  .option('--all', 'Remove all registered worktrees', false)
  .option('--force', 'Remove even if worktree has uncommitted changes or unpushed commits', false)
  .option('--keep-db', 'Keep the database (do not drop)', false)
  .option('--json', 'Output as JSON', false)
  .addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  wt remove 1',
      '  wt remove 1,2',
      '  wt remove "1, 2"',
      '  wt remove .worktrees/feat-auth',
      '  wt remove --all',
      '',
    ].join('\n'),
  )
  .action(async (targets: string[] | undefined, opts) => {
    await removeCommand(targets ?? [], {
      json: opts.json,
      keepDb: opts.keepDb,
      all: opts.all,
      force: opts.force,
    });
  });

program
  .command('prune')
  .description('Prune Git-prunable worktrees and clean up managed resources')
  .option('--dry-run', 'Show what would be pruned without changing anything', false)
  .option('--keep-db', 'Keep databases for managed worktrees (do not drop)', false)
  .option('--merged', 'Also remove live worktrees whose branch is merged into the base ref (audit-confirmed, clean only)', false)
  .option('--json', 'Output as JSON', false)
  .action(async (opts) => {
    await pruneCommand({
      json: opts.json,
      keepDb: opts.keepDb,
      dryRun: opts.dryRun,
      merged: opts.merged,
    });
  });

program
  .command('audit')
  .description('Classify worktrees by how their branch relates to the base ref and suggest which are safe to remove')
  .option('--json', 'Output as JSON', false)
  .option('--no-fetch', 'Skip fetching origin/main before auditing')
  .option('--base <ref>', 'Base ref to audit against (default: origin/main, then main)')
  .option('--ignore-dirty <paths...>', 'Worktree path fragments to treat as never-real dirt (e.g. .mcp.json)', [])
  .addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  wt audit',
      '  wt audit --no-fetch',
      '  wt audit --json | jq \'.data[] | select(.verdict=="delete-merged")\'',
      '',
    ].join('\n'),
  )
  .action((opts) => {
    auditCommand({
      json: opts.json,
      fetch: opts.fetch,
      base: opts.base,
      ignoreDirty: opts.ignoreDirty,
    });
  });

program
  .command('list')
  .description('List all worktree allocations')
  .option('--json', 'Output as JSON', false)
  .action((opts) => {
    const repoRoot = getMainWorktreePath();
    listCommand(repoRoot, { json: opts.json });
  });

program
  .command('doctor')
  .description('Diagnose and fix worktree environment issues')
  .option('--fix', 'Auto-repair stale entries and orphaned databases', false)
  .option('--json', 'Output as JSON', false)
  .action(async (opts) => {
    await doctorCommand({ json: opts.json, fix: opts.fix });
  });

program.parse();

process.stderr.write(getUpdateNotice(version) + '\n');
if (!isCacheFresh()) {
  refreshUpdateCache(name);
}
