import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { configSchema } from '../schemas/config.schema';
import { readRegistry, writeRegistry, addAllocation, findByPath } from '../core/registry';
import {
  calculateDbName,
  findAvailableSlot,
  allocateServicePorts,
  validatePortPlan,
} from '../core/slot-allocator';
import { copyAndPatchAllEnvFiles } from '../core/env-patcher';
import { createDatabase, databaseExists } from '../core/database';
import {
  ensureDockerServices,
  buildDockerComposeConfig,
  computeServiceHashes,
} from '../core/docker-services';
import { getMainWorktreePath, isMainWorktree, getBranchName } from '../core/git';
import { extractErrorMessage, formatJson, formatRepairPreview, formatSetupSummary, success, error } from '../output';
import type { Allocation, PortChange, PortDrift, WtConfig } from '../types';

interface SetupOptions {
  readonly json: boolean;
  readonly install: boolean;
  readonly repair: boolean;
  readonly dryRun: boolean;
}

function validateConfig(config: WtConfig): WtConfig {
  const seenServiceNames = new Set<string>();
  for (const service of config.services) {
    if (seenServiceNames.has(service.name)) {
      throw new Error(`Duplicate service name in wt.config.json: ${service.name}`);
    }
    seenServiceNames.add(service.name);
  }

  for (const envFile of config.envFiles) {
    for (const patch of envFile.patches) {
      if ('service' in patch && !seenServiceNames.has(patch.service)) {
        throw new Error(
          `Patch '${patch.var}' references unknown service '${patch.service}'.`,
        );
      }
    }
  }

  const seenDockerServiceNames = new Set<string>();
  for (const dockerService of config.dockerServices) {
    if (seenDockerServiceNames.has(dockerService.name)) {
      throw new Error(`Duplicate docker service name in wt.config.json: ${dockerService.name}`);
    }
    seenDockerServiceNames.add(dockerService.name);

    for (const port of dockerService.ports) {
      if (!seenServiceNames.has(port.service)) {
        throw new Error(
          `Docker service '${dockerService.name}' references unknown port service '${port.service}'.`,
        );
      }
    }
  }

  validatePortPlan(config.services, config.maxSlots, config.portStride);
  return config;
}

/** Load and validate wt.config.json from the main worktree */
export function loadConfig(mainRoot: string): WtConfig {
  const configPath = path.join(mainRoot, 'wt.config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  return validateConfig(configSchema.parse(raw));
}

/**
 * Read DATABASE_URL from the main worktree's .env file.
 * Used to connect to Postgres for admin operations.
 */
function readDatabaseUrl(mainRoot: string): string {
  const envPath = path.join(mainRoot, '.env');
  const content = fs.readFileSync(envPath, 'utf-8');
  const match = content.match(/^DATABASE_URL=["']?([^"'\n]+)/m);
  if (!match?.[1]) {
    throw new Error('DATABASE_URL not found in .env');
  }
  return match[1];
}

/** Set up an existing worktree with isolated DB, Docker services, ports, and env files */
export async function setupCommand(
  targetPath: string | undefined,
  options: SetupOptions,
): Promise<void> {
  try {
    const worktreePath = path.resolve(targetPath ?? process.cwd());
    const mainRoot = getMainWorktreePath();

    if (isMainWorktree(worktreePath)) {
      const msg = 'Cannot setup the main worktree. Use this on secondary worktrees.';
      if (options.json) {
        console.log(formatJson(error('MAIN_WORKTREE', msg)));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }

    // Flag validation.
    if (options.dryRun && !options.repair) {
      const msg = '--dry-run requires --repair.';
      if (options.json) {
        console.log(formatJson(error('INVALID_OPTIONS', msg)));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }

    const config = loadConfig(mainRoot);
    let registry = readRegistry(mainRoot);

    // Reuse existing allocation or allocate a new slot.
    // For an existing allocation, reuse the registered ports verbatim so
    // re-runs of `wt setup` don't overwrite drifted ports with formula
    // values.
    const existing = findByPath(registry, worktreePath);

    if (options.repair && !existing) {
      const msg = '--repair requires an existing worktree allocation; remove --repair to set up fresh.';
      if (options.json) {
        console.log(formatJson(error('NO_ALLOCATION', msg)));
      } else {
        console.error(msg);
      }
      process.exitCode = 1;
      return;
    }

    let slot: number;
    let ports: Record<string, number>;
    let portDrifts: readonly PortDrift[];

    if (existing) {
      slot = existing[0];
      if (options.repair) {
        const allocated = await allocateServicePorts(
          slot,
          config.services,
          config.portStride,
          registry,
          { excludeSlot: slot },
        );
        ports = allocated.ports;
        portDrifts = allocated.drifts;
      } else {
        ports = existing[1].ports;
        portDrifts = [];
      }
    } else {
      const available = findAvailableSlot(registry, config.maxSlots);
      if (available === null) {
        const msg =
          `All ${config.maxSlots} slots are occupied. ` +
          'Remove a worktree or increase maxSlots.';
        if (options.json) {
          console.log(formatJson(error('NO_SLOTS', msg)));
        } else {
          console.error(msg);
        }
        process.exitCode = 1;
        return;
      }
      slot = available;
      const allocated = await allocateServicePorts(
        slot,
        config.services,
        config.portStride,
        registry,
      );
      ports = allocated.ports;
      portDrifts = allocated.drifts;
      if (!options.json) {
        for (const drift of portDrifts) {
          const detail =
            drift.conflict.kind === 'os'
              ? `in use by ${drift.conflict.description}`
              : `reserved by slot ${drift.conflict.slot} (${drift.conflict.service})`;
          process.stderr.write(
            `Port ${drift.requested} (${drift.service}) ${detail}; ` +
            `using ${drift.assigned} instead.\n`,
          );
        }
      }
    }

    const dbName = calculateDbName(slot, config.baseDatabaseName);
    const branchName = getBranchName(worktreePath);

    // Create database if it doesn't exist
    const databaseUrl = readDatabaseUrl(mainRoot);
    const dbAlreadyExists = await databaseExists(databaseUrl, dbName);
    if (!dbAlreadyExists) {
      await createDatabase(databaseUrl, config.baseDatabaseName, dbName);
    }

    // Compute current compose hashes and diff against stored ones to
    // decide which docker services need recreation. Missing stored
    // hashes (pre-upgrade allocation) are treated as in-sync — we don't
    // know what was actually applied, so we don't recreate anything;
    // we simply store the current hashes and the next config edit will
    // be detected normally.
    const composeConfig = buildDockerComposeConfig({
      mainRoot,
      slot,
      branchName,
      worktreePath,
      dbName,
      ports,
      config,
    });
    const currentHashes = computeServiceHashes(composeConfig);
    const storedHashes = existing?.[1].docker?.serviceHashes;
    const recreateServices = storedHashes
      ? Object.entries(currentHashes)
          .filter(([name, hash]) => storedHashes[name] !== undefined && storedHashes[name] !== hash)
          .map(([name]) => name)
      : [];

    // Compute portChanges (registered → proposed) for repair output.
    const portChanges: PortChange[] = options.repair && existing
      ? config.services.map((service) => {
          const registered = existing[1].ports[service.name] ?? 0;
          const proposed = ports[service.name] ?? 0;
          if (registered === proposed) {
            return { service: service.name, registered, proposed, reason: 'unchanged' };
          }
          const drift = portDrifts.find((d) => d.service === service.name);
          if (drift) {
            const reason = drift.conflict.kind === 'os'
              ? `in use by ${drift.conflict.description}`
              : `reserved by slot ${drift.conflict.slot} (${drift.conflict.service})`;
            return { service: service.name, registered, proposed, reason };
          }
          return { service: service.name, registered, proposed, reason: 'natural port now free' };
        })
      : [];

    if (options.repair) {
      const preview = formatRepairPreview({
        slot,
        dbName,
        changes: portChanges,
        recreatedDockerServices: recreateServices,
        dryRun: options.dryRun,
      });
      if (!options.json) {
        process.stdout.write(preview);
      }

      const anyChange = portChanges.some((c) => c.registered !== c.proposed);
      const noopRepair = !anyChange && recreateServices.length === 0;

      if (options.dryRun || noopRepair) {
        if (options.json) {
          console.log(
            formatJson(
              success({
                slot,
                ports,
                portDrifts,
                portChanges,
                recreatedDockerServices: options.dryRun ? recreateServices : [],
                repaired: true,
                dryRun: options.dryRun,
              }),
            ),
          );
        }
        return;
      }
    }

    const docker = ensureDockerServices({
      mainRoot,
      slot,
      branchName,
      worktreePath,
      dbName,
      ports,
      config,
      recreateServices,
    });

    // Copy and patch env files
    copyAndPatchAllEnvFiles(config, mainRoot, worktreePath, {
      dbName,
      ports,
      branchName,
    });

    // Update registry
    const allocation: Allocation = {
      worktreePath,
      branchName,
      dbName,
      docker,
      ports,
      createdAt: new Date().toISOString(),
    };
    registry = addAllocation(registry, slot, allocation);
    writeRegistry(mainRoot, registry);

    // Run post-setup commands
    if (config.autoInstall && options.install && config.postSetup.length > 0) {
      for (const cmd of config.postSetup) {
        console.log(`Running: ${cmd}`);
        execSync(cmd, { cwd: worktreePath, stdio: 'inherit' });
      }
    }

    if (options.json) {
      console.log(
        formatJson(
          success({
            slot,
            ...allocation,
            portDrifts,
            portChanges,
            recreatedDockerServices: recreateServices,
            repaired: !!options.repair,
            dryRun: !!options.dryRun,
          }),
        ),
      );
    } else {
      console.log(formatSetupSummary(slot, allocation));
    }
  } catch (err) {
    const message = extractErrorMessage(err);
    if (options.json) {
      console.log(formatJson(error('SETUP_FAILED', message)));
    } else {
      console.error(`Setup failed: ${message}`);
    }
    process.exitCode = 1;
  }
}
