import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readRegistry,
  writeRegistry,
  addAllocation,
  removeAllocation,
  findByPath,
} from '../src/core/registry';
import type { Registry, Allocation } from '../src/types';

describe('registry', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleAllocation: Allocation = {
    worktreePath: '/tmp/worktrees/feat-test',
    branchName: 'feat/test',
    dbName: 'cryptoacc_wt1',
    redisDb: 1,
    ports: { app: 3100, server: 3101 },
    createdAt: '2026-02-17T14:30:00Z',
  };

  describe('readRegistry', () => {
    it('returns empty registry when file does not exist', () => {
      // Act
      const registry = readRegistry(tmpDir);

      // Assert
      expect(registry).toEqual({ version: 1, allocations: {} });
    });

    it('reads and validates an existing registry file', () => {
      // Arrange
      const data: Registry = {
        version: 1,
        allocations: { '1': sampleAllocation },
      };
      fs.writeFileSync(
        path.join(tmpDir, '.worktree-registry.json'),
        JSON.stringify(data),
      );

      // Act
      const registry = readRegistry(tmpDir);

      // Assert
      expect(registry.allocations['1']?.branchName).toBe('feat/test');
    });
  });

  describe('writeRegistry', () => {
    it('writes registry to disk and can be read back', () => {
      // Arrange
      const registry: Registry = {
        version: 1,
        allocations: { '1': sampleAllocation },
      };

      // Act
      writeRegistry(tmpDir, registry);

      // Assert
      const readBack = readRegistry(tmpDir);
      expect(readBack).toEqual(registry);
    });
  });

  describe('addAllocation', () => {
    it('adds an allocation to an empty registry', () => {
      // Arrange
      const empty: Registry = { version: 1, allocations: {} };

      // Act
      const updated = addAllocation(empty, 1, sampleAllocation);

      // Assert
      expect(updated.allocations['1']).toEqual(sampleAllocation);
      expect(Object.keys(updated.allocations)).toHaveLength(1);
    });

    it('does not mutate the original registry', () => {
      // Arrange
      const original: Registry = { version: 1, allocations: {} };

      // Act
      addAllocation(original, 1, sampleAllocation);

      // Assert
      expect(Object.keys(original.allocations)).toHaveLength(0);
    });
  });

  describe('removeAllocation', () => {
    it('removes a slot from the registry', () => {
      // Arrange
      const registry: Registry = {
        version: 1,
        allocations: { '1': sampleAllocation },
      };

      // Act
      const updated = removeAllocation(registry, 1);

      // Assert
      expect(Object.keys(updated.allocations)).toHaveLength(0);
    });
  });

  describe('findByPath', () => {
    it('finds allocation by worktree path', () => {
      // Arrange
      const registry: Registry = {
        version: 1,
        allocations: { '3': { ...sampleAllocation, worktreePath: '/tmp/wt3' } },
      };

      // Act
      const result = findByPath(registry, '/tmp/wt3');

      // Assert
      expect(result).not.toBeNull();
      expect(result![0]).toBe(3);
    });

    it('returns null for unknown path', () => {
      // Arrange
      const registry: Registry = { version: 1, allocations: {} };

      // Act & Assert
      expect(findByPath(registry, '/nonexistent')).toBeNull();
    });
  });
});
