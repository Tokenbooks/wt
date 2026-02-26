#!/usr/bin/env node

import { Command } from 'commander';
import { newCommand } from './commands/new';
import { setupCommand } from './commands/setup';
import { removeCommand } from './commands/remove';
import { listCommand } from './commands/list';
import { doctorCommand } from './commands/doctor';
import { openCommand } from './commands/open';
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
  .argument('<branch>', 'Branch name to create or checkout')
  .option('--slot <n>', 'Force a specific slot number')
  .option('--no-install', 'Skip post-setup commands')
  .option('--json', 'Output as JSON', false)
  .action(async (branch: string, opts) => {
    await newCommand(branch, {
      json: opts.json,
      install: opts.install,
      slot: opts.slot,
    });
  });

program
  .command('setup')
  .description('Set up environment for an existing worktree')
  .argument('[path]', 'Worktree path (default: current directory)')
  .option('--no-install', 'Skip post-setup commands')
  .option('--json', 'Output as JSON', false)
  .action(async (targetPath: string | undefined, opts) => {
    await setupCommand(targetPath, {
      json: opts.json,
      install: opts.install,
    });
  });

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
