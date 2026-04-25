import * as net from 'node:net';
import { describe, it, expect } from '@jest/globals';
import {
  calculatePorts,
  calculateDbName,
  findAvailableSlot,
  validatePortPlan,
  parseLsofOutput,
  describeListener,
  allocateServicePorts,
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

  describe('validatePortPlan', () => {
    it('rejects collisions between main and worktree slots', () => {
      expect(() => {
        validatePortPlan(
          [
            { name: 'web', defaultPort: 3000 },
            { name: 'worker', defaultPort: 3100 },
          ],
          2,
          100,
        );
      }).toThrow('Port 3100 collides');
    });

    it('rejects ports above the valid range', () => {
      expect(() => {
        validatePortPlan(
          [{ name: 'web', defaultPort: 65000 }],
          10,
          100,
        );
      }).toThrow('exceeds 65535');
    });
  });

  describe('parseLsofOutput', () => {
    it('parses pid and command from a single listener', () => {
      const out = 'p12345\ncnode\nn*:3200\n';
      expect(parseLsofOutput(out)).toEqual({ pid: 12345, command: 'node' });
    });

    it('returns the first listener when multiple are reported', () => {
      const out = 'p12345\ncnode\nn127.0.0.1:3200\np67890\ncpython3\nn*:3200\n';
      expect(parseLsofOutput(out)).toEqual({ pid: 12345, command: 'node' });
    });

    it('returns null on empty output', () => {
      expect(parseLsofOutput('')).toBeNull();
    });

    it('returns null when only a name field is present', () => {
      expect(parseLsofOutput('n*:3200\n')).toBeNull();
    });
  });

  describe('describeListener', () => {
    it('returns a description for a real local listener', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP address.');
      }

      const description = await describeListener(address.port);

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });

      // Best-effort: on macOS/linux this should match `<command>[<pid>]`.
      // On platforms without lsof we fall back to "unknown process".
      expect(description).toMatch(/^(.+\[\d+\]|unknown process)$/);
    });

    it('returns "unknown process" when no one is listening', async () => {
      // Port 1 is reserved/unprivileged and almost certainly free.
      // lsof returns a non-zero exit when no match is found; we treat it
      // as "unknown process" rather than throwing.
      const description = await describeListener(1);
      expect(description).toBe('unknown process');
    });
  });

  describe('allocateServicePorts', () => {
    const services = [
      { name: 'web', defaultPort: 3000 },
      { name: 'api', defaultPort: 4000 },
    ] as const;
    const stride = 100;

    function emptyRegistry(): Registry {
      return { version: 1, allocations: {} };
    }

    it('returns natural ports with no drift when everything is free', async () => {
      // Use OS-assigned ephemeral ports so this test doesn't flake on
      // machines where the hard-coded 3200/4200 happen to be in use.
      const probeA = net.createServer();
      const probeB = net.createServer();
      await new Promise<void>((resolve) => probeA.listen(0, '127.0.0.1', () => resolve()));
      await new Promise<void>((resolve) => probeB.listen(0, '127.0.0.1', () => resolve()));
      const addrA = probeA.address();
      const addrB = probeB.address();
      if (!addrA || typeof addrA === 'string' || !addrB || typeof addrB === 'string') {
        throw new Error('Expected TCP addresses.');
      }
      const portA = addrA.port;
      const portB = addrB.port;
      await new Promise<void>((resolve, reject) => probeA.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve, reject) => probeB.close((err) => (err ? reject(err) : resolve())));

      const slot = 2;
      const localStride = 100;
      const localServices = [
        { name: 'web', defaultPort: portA - slot * localStride },
        { name: 'api', defaultPort: portB - slot * localStride },
      ] as const;

      const result = await allocateServicePorts(slot, localServices, localStride, emptyRegistry());

      expect(result.ports).toEqual({ web: portA, api: portB });
      expect(result.drifts).toEqual([]);
    });

    it('drifts a service whose natural port is bound at the OS level', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(3200, '127.0.0.1', () => resolve()));

      try {
        const result = await allocateServicePorts(2, services, stride, emptyRegistry());

        expect(result.ports.web).toBe(3201);
        expect(result.ports.api).toBe(4200);
        expect(result.drifts).toHaveLength(1);
        expect(result.drifts[0]).toMatchObject({
          service: 'web',
          requested: 3200,
          assigned: 3201,
          conflict: { kind: 'os' },
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('skips ports already in another slot\'s allocation without probing', async () => {
      const registry: Registry = {
        version: 1,
        allocations: {
          '1': {
            worktreePath: '/tmp/wt1',
            branchName: 'feat/a',
            dbName: 'db_wt1',
            ports: { web: 3200, api: 4100 },
            createdAt: '2026-04-25T00:00:00.000Z',
          },
        },
      };

      const result = await allocateServicePorts(2, services, stride, registry);

      // web's natural 3200 is reserved by slot 1; drift to 3201.
      // api's natural 4200 is free.
      expect(result.ports).toEqual({ web: 3201, api: 4200 });
      expect(result.drifts).toEqual([
        {
          service: 'web',
          requested: 3200,
          assigned: 3201,
          conflict: { kind: 'internal', slot: 1, service: 'web' },
        },
      ]);
    });

    it('drifts only the conflicting service in a multi-service config', async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(4200, '127.0.0.1', () => resolve()));

      try {
        const result = await allocateServicePorts(2, services, stride, emptyRegistry());

        expect(result.ports.web).toBe(3200);
        expect(result.ports.api).toBe(4201);
        expect(result.drifts.map((d) => d.service)).toEqual(['api']);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('throws when a service exhausts the port space at 65535', async () => {
      // Service whose natural port is 65535, with that port internally
      // reserved — drift would have to go to 65536, which we refuse.
      const registry: Registry = {
        version: 1,
        allocations: {
          '1': {
            worktreePath: '/tmp/wt1',
            branchName: 'feat/a',
            dbName: 'db_wt1',
            ports: { edge: 65535 },
            createdAt: '2026-04-25T00:00:00.000Z',
          },
        },
      };
      const edgeServices = [{ name: 'edge', defaultPort: 65535 }] as const;

      await expect(
        allocateServicePorts(0, edgeServices, 0, registry),
      ).rejects.toThrow(/No available port for service 'edge'/);
    });
  });
});

/** Helper to create a minimal allocation for testing */
function makeAllocation(slot: number) {
  return {
    worktreePath: `/tmp/wt${slot}`,
    branchName: `feat/test-${slot}`,
    dbName: `cryptoacc_wt${slot}`,
    ports: { app: 3000 + slot * 100, redis: 6379 + slot * 100 },
    createdAt: new Date().toISOString(),
  };
}
