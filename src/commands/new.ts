import * as path from 'node:path';
import { readRegistry, writeRegistry, addAllocation } from '../core/registry';
import {
  calculateDbName,
  findAvailableSlot,
  allocateServicePorts,
} from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists, dropDatabase } from '../core/database';
import {
  ensureDockerServices,
  removeDockerServices,
} from '../core/docker-services';
import {
  getMainWorktreePath,
  createWorktree,
  getBranchName,
  removeWorktree,
  deleteBranch,
  resolveWorktreeBranch,
  generateAutoBranchName,
  assertRefExists,
  type WorktreeBranchSelection,
} from '../core/git';
import { resolveBaseRef } from '../core/audit';
import { extractErrorMessage, formatJson, formatSetupSummary, success, error } from '../output';
import { loadConfig } from './setup';
import type { Allocation, PortDrift } from '../types';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

interface NewOptions {
  readonly json: boolean;
  readonly install: boolean;
  readonly slot?: string;
  readonly base?: string;
}

export interface CreateWorktreeResult {
  readonly slot: number;
  readonly allocation: Allocation;
  readonly branchSelection: WorktreeBranchSelection;
  readonly portDrifts: readonly PortDrift[];
  readonly autoNamed: boolean;
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
 * Fork point for an auto-named branch when the user did not pass `--base`.
 * Re-phrases the audit helper's failure, which talks about auditing, into
 * advice that makes sense for `wt new`.
 */
function resolveDefaultBase(mainRoot: string): string {
  try {
    return resolveBaseRef(mainRoot);
  } catch {
    throw new Error(
      "no default base found (looked for 'origin/main', then 'main'); " +
      'pass --base <ref> or name a branch',
    );
  }
}

/** Core worktree creation logic — returns the result for programmatic use */
export async function createNewWorktree(
  branchNameArg: string | undefined,
  options: { install: boolean; slot?: string; quiet?: boolean; base?: string },
): Promise<CreateWorktreeResult> {
  const log = options.quiet
    ? () => {}
    : (msg: string) => process.stderr.write(`${msg}\n`);
  const warn = (msg: string) => process.stderr.write(`${msg}\n`);

  const mainRoot = getMainWorktreePath();
  const config = loadConfig(mainRoot);
  let registry = readRegistry(mainRoot);

  // Determine slot first — it is pure bookkeeping over the registry, so an
  // unusable --slot fails before any git lookup hits the network or writes a
  // remote-tracking ref. Port availability no longer affects slot choice.
  let slot: number;
  if (options.slot !== undefined) {
    slot = parseInt(options.slot, 10);
    if (isNaN(slot) || slot < 1 || slot > config.maxSlots) {
      throw new Error(`Invalid slot: ${options.slot}. Must be 1-${config.maxSlots}.`);
    }
    if (String(slot) in registry.allocations) {
      throw new Error(`Slot ${slot} is already occupied.`);
    }
  } else {
    const available = findAvailableSlot(registry, config.maxSlots);
    if (available === null) {
      throw new Error(
        `All ${config.maxSlots} slots are occupied. ` +
        'Remove a worktree or increase maxSlots.',
      );
    }
    slot = available;
  }

  // Resolve the branch name and its fork point before allocating anything. When
  // no name is given we auto-name a throwaway branch (e.g. main-20260723-nemanull)
  // and fork it off the base ref; validating the base up front means a bad
  // --base fails cleanly before any database, Docker, or worktree resources exist.
  let base = options.base;
  let branchName: string;
  let autoNamed = false;
  if (branchNameArg !== undefined) {
    branchName = branchNameArg;
  } else {
    base = base ?? resolveDefaultBase(mainRoot);
    branchName = generateAutoBranchName(base);
    autoNamed = true;
  }

  const basePath = path.join(mainRoot, config.baseWorktreePath);
  const branchSelection = resolveWorktreeBranch(
    branchName,
    (command) => log(`Running: ${command}`),
    // A name wt invented is meant to be a fresh branch off the base, so an
    // unrelated origin branch that happens to match must not be adopted.
    { base, skipOriginLookup: autoNamed },
  );
  if (branchSelection.originCheckError) {
    warn(`Failed to check origin for '${branchName}': ${branchSelection.originCheckError}`);
  }
  if (base !== undefined) {
    if (branchSelection.source === 'local-new') {
      // The base is only used when we create a fresh branch; fail early on a typo.
      assertRefExists(base);
    } else if (options.base !== undefined) {
      // Only mention the flag if the user actually passed one.
      warn(`Branch '${branchName}' already exists; --base ${options.base} ignored.`);
    }
  }

  log(`Creating worktree for '${branchName}' in slot ${slot}...`);
  log(describeBranchSelection(branchSelection));

  const dbName = calculateDbName(slot, config.baseDatabaseName);
  const { ports, drifts: portDrifts } = await allocateServicePorts(
    slot,
    config.services,
    config.portStride,
    registry,
  );
  for (const drift of portDrifts) {
    const detail =
      drift.conflict.kind === 'os'
        ? `in use by ${drift.conflict.description}`
        : `reserved by slot ${drift.conflict.slot} (${drift.conflict.service})`;
    log(
      `Port ${drift.requested} (${drift.service}) ${detail}; ` +
      `using ${drift.assigned} instead.`,
    );
  }
  const databaseUrl = readDatabaseUrl(mainRoot);

  // Track what each step has created so we can roll back on failure. Resource
  // leaks from partially-successful `wt new` runs are hard to clean up later;
  // everything allocated here must be torn down if we fail before writing the
  // registry.
  let worktreeCreated = false;
  let dockerStarted = false;
  let databaseCreated = false;
  let worktreePath: string;
  let actualBranch: string;
  let allocation: Allocation;

  try {
    worktreePath = createWorktree(
      basePath,
      branchSelection,
      (command) => log(`Running: ${command}`),
    );
    worktreeCreated = true;
    actualBranch = getBranchName(worktreePath);

    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      log(`Creating database '${dbName}'...`);
      await createDatabase(
        databaseUrl,
        config.baseDatabaseName,
        dbName,
        (statement) => log(`Running SQL: ${statement}`),
      );
      databaseCreated = true;
    } else {
      log(`Database '${dbName}' already exists, reusing.`);
    }

    dockerStarted = config.dockerServices.length > 0;
    const docker = ensureDockerServices({
      mainRoot,
      slot,
      branchName: actualBranch,
      worktreePath,
      dbName,
      ports,
      config,
      log,
    });

    log(`Patching ${config.envFiles.length} env file(s)...`);
    copyAndPatchAllEnvFiles(config, mainRoot, worktreePath, {
      dbName,
      ports,
      branchName: actualBranch,
    });

    allocation = {
      worktreePath,
      branchName: actualBranch,
      dbName,
      docker,
      ports,
      createdAt: new Date().toISOString(),
    };
    registry = addAllocation(registry, slot, allocation);
    writeRegistry(mainRoot, registry);
  } catch (err) {
    const reason = extractErrorMessage(err);
    warn(`Failed to create worktree for '${branchName}' in slot ${slot}: ${reason}`);
    warn('Rolling back partial setup...');

    if (dockerStarted) {
      try {
        removeDockerServices(mainRoot, slot, log);
      } catch (rollbackErr) {
        warn(`Rollback failed to remove Docker services for slot ${slot}: ${extractErrorMessage(rollbackErr)}`);
      }
    }

    if (databaseCreated) {
      try {
        await dropDatabase(
          databaseUrl,
          dbName,
          config.baseDatabaseName,
          (statement) => log(`Rollback SQL: ${statement}`),
        );
        log(`Rollback: dropped database '${dbName}'.`);
      } catch (rollbackErr) {
        warn(`Rollback failed to drop database '${dbName}': ${extractErrorMessage(rollbackErr)}`);
      }
    }

    if (worktreeCreated && worktreePath! && fs.existsSync(worktreePath!)) {
      try {
        removeWorktree(worktreePath!, (command) => log(`Rollback: ${command}`));
        log(`Rollback: removed worktree at ${worktreePath!}.`);

        // An auto-named branch exists only because wt invented it, so leaving it
        // behind is pure litter — and the next run's collision suffix would have
        // to step over it. A branch the user named is theirs to keep.
        if (autoNamed && branchSelection.source === 'local-new') {
          try {
            deleteBranch(branchName, (command) => log(`Rollback: ${command}`));
            log(`Rollback: deleted auto-named branch '${branchName}'.`);
          } catch (branchErr) {
            warn(`Rollback failed to delete branch '${branchName}': ${extractErrorMessage(branchErr)}`);
          }
        }
      } catch (rollbackErr) {
        warn(`Rollback failed to remove worktree at ${worktreePath!}: ${extractErrorMessage(rollbackErr)}`);
      }
    }

    throw err;
  }

  // Run post-setup commands
  if (config.autoInstall && options.install && config.postSetup.length > 0) {
    for (const cmd of config.postSetup) {
      log(`Running: ${cmd}`);
      execSync(cmd, { cwd: worktreePath, stdio: 'inherit' });
    }
  }

  log(`Ready — slot ${slot}, branch '${actualBranch}'.`);
  return { slot, allocation, branchSelection, portDrifts, autoNamed };
}

/** Create a new worktree with full environment isolation */
export async function newCommand(
  branchName: string | undefined,
  options: NewOptions,
): Promise<void> {
  try {
    const { slot, allocation, branchSelection, portDrifts, autoNamed } = await createNewWorktree(branchName, {
      ...options,
      quiet: options.json,
    });

    if (options.json) {
      console.log(
        formatJson(
          success({
            slot,
            ...allocation,
            branchSource: branchSelection.source,
            branchSourceLabel: branchSelection.sourceLabel,
            startPoint: branchSelection.startPoint ?? null,
            autoNamed,
            portDrifts,
          }),
        ),
      );
    } else {
      console.log(
        formatSetupSummary(slot, allocation, {
          branchSourceLabel: branchSelection.sourceLabel,
        }),
      );
    }
  } catch (err) {
    const message = extractErrorMessage(err);
    if (options.json) {
      console.log(formatJson(error('NEW_FAILED', message)));
    } else {
      console.error(`Failed to create worktree: ${message}`);
    }
    process.exitCode = 1;
  }
}

function describeBranchSelection(branchSelection: WorktreeBranchSelection): string {
  switch (branchSelection.source) {
    case 'origin':
      return `Using branch '${branchSelection.branchName}' from ${branchSelection.sourceLabel}.`;
    case 'local-existing':
      return `Using existing local branch '${branchSelection.branchName}'.`;
    case 'local-new':
      return branchSelection.startPoint
        ? `Using branch '${branchSelection.branchName}' as a fresh local branch from ${branchSelection.startPoint}.`
        : `Using branch '${branchSelection.branchName}' as a fresh local branch.`;
  }
}
