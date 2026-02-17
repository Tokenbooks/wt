import { describe, it, expect } from '@jest/globals';
import {
  calculatePorts,
  calculateDbName,
  findAvailableSlot,
} from '../src/core/slot-allocator';
import type { Registry } from '../src/types';

describe('slot-allocator', () => {
  const services = [
    { name: 'app', defaultPort: 3000 },
    { name: 'server', defaultPort: 3001 },
    { name: 'sync-exchanges', defaultPort: 3002 },
  ] as const;
  const stride = 100;

  describe('calculatePorts', () => {
    it.each([
      [0, { app: 3000, server: 3001, 'sync-exchanges': 3002 }],
      [1, { app: 3100, server: 3101, 'sync-exchanges': 3102 }],
      [5, { app: 3500, server: 3501, 'sync-exchanges': 3502 }],
      [10, { app: 4000, server: 4001, 'sync-exchanges': 4002 }],
      [15, { app: 4500, server: 4501, 'sync-exchanges': 4502 }],
    ])('slot %i → %o', (slot, expected) => {
      // Act
      const result = calculatePorts(slot, services, stride);

      // Assert
      expect(result).toEqual(expected);
    });
  });

  describe('calculateDbName', () => {
    it.each([
      [1, 'cryptoacc', 'cryptoacc_wt1'],
      [3, 'cryptoacc', 'cryptoacc_wt3'],
      [15, 'mydb', 'mydb_wt15'],
    ])('slot %i, base "%s" → "%s"', (slot, baseName, expected) => {
      // Act & Assert
      expect(calculateDbName(slot, baseName)).toBe(expected);
    });
  });

  describe('findAvailableSlot', () => {
    it('returns 1 for an empty registry', () => {
      // Arrange
      const registry: Registry = { version: 1, allocations: {} };

      // Act & Assert
      expect(findAvailableSlot(registry, 15)).toBe(1);
    });

    it('skips occupied slots and returns the next free one', () => {
      // Arrange
      const registry: Registry = {
        version: 1,
        allocations: {
          '1': makeAllocation(1),
          '2': makeAllocation(2),
          '4': makeAllocation(4),
        },
      };

      // Act & Assert
      expect(findAvailableSlot(registry, 15)).toBe(3);
    });

    it('returns null when all slots are taken', () => {
      // Arrange
      const allocations: Record<string, ReturnType<typeof makeAllocation>> = {};
      for (let i = 1; i <= 3; i++) {
        allocations[String(i)] = makeAllocation(i);
      }
      const registry: Registry = { version: 1, allocations };

      // Act & Assert
      expect(findAvailableSlot(registry, 3)).toBeNull();
    });
  });
});

/** Helper to create a minimal allocation for testing */
function makeAllocation(slot: number) {
  return {
    worktreePath: `/tmp/wt${slot}`,
    branchName: `feat/test-${slot}`,
    dbName: `cryptoacc_wt${slot}`,
    redisDb: slot,
    ports: { app: 3000 + slot * 100 },
    createdAt: new Date().toISOString(),
  };
}
