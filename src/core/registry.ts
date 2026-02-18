import * as fs from 'node:fs';
import * as path from 'node:path';
import { registrySchema } from '../schemas/registry.schema';
import type { Registry, Allocation } from '../types';

const REGISTRY_FILENAME = '.worktree-registry.json';

/** Create an empty registry object */
function createEmptyRegistry(): Registry {
  return { version: 1, allocations: {} };
}

/** Resolve the absolute path to the registry file */
function registryPath(repoRoot: string): string {
  return path.join(repoRoot, REGISTRY_FILENAME);
}

/**
 * Read and validate the worktree registry from disk.
 * Returns an empty registry if the file doesn't exist.
 */
export function readRegistry(repoRoot: string): Registry {
  const filePath = registryPath(repoRoot);
  if (!fs.existsSync(filePath)) {
    return createEmptyRegistry();
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return registrySchema.parse(raw);
}

/**
 * Write the registry to disk atomically (tmp file + rename).
 * This prevents corruption if the process is killed mid-write.
 */
export function writeRegistry(repoRoot: string, registry: Registry): void {
  const filePath = registryPath(repoRoot);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/** Add an allocation to the registry, returning a new registry object */
export function addAllocation(
  registry: Registry,
  slot: number,
  allocation: Allocation,
): Registry {
  return {
    ...registry,
    allocations: {
      ...registry.allocations,
      [String(slot)]: allocation,
    },
  };
}

/** Remove an allocation from the registry, returning a new registry object */
export function removeAllocation(registry: Registry, slot: number): Registry {
  const rest = Object.fromEntries(
    Object.entries(registry.allocations).filter(([key]) => key !== String(slot)),
  );
  return { ...registry, allocations: rest };
}

/**
 * Find an allocation by its worktree path.
 * Returns [slot, allocation] or null if not found.
 */
export function findByPath(
  registry: Registry,
  worktreePath: string,
): [number, Allocation] | null {
  const resolved = path.resolve(worktreePath);
  for (const [slotStr, allocation] of Object.entries(registry.allocations)) {
    if (path.resolve(allocation.worktreePath) === resolved) {
      return [Number(slotStr), allocation];
    }
  }
  return null;
}
