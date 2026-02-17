import type { ServiceConfig, Registry } from '../types';

/**
 * Calculate port assignments for a given slot.
 * Formula: slot * stride + service.defaultPort
 */
export function calculatePorts(
  slot: number,
  services: readonly ServiceConfig[],
  stride: number,
): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const service of services) {
    ports[service.name] = slot * stride + service.defaultPort;
  }
  return ports;
}

/**
 * Calculate the database name for a given slot.
 * Returns "baseName_wtN" where N is the slot number.
 */
export function calculateDbName(slot: number, baseName: string): string {
  return `${baseName}_wt${slot}`;
}

/**
 * Find the next available slot in the registry.
 * Scans slots 1..maxSlots and returns the first unoccupied one.
 * Returns null if all slots are taken.
 */
export function findAvailableSlot(
  registry: Registry,
  maxSlots: number,
): number | null {
  for (let slot = 1; slot <= maxSlots; slot++) {
    if (!(String(slot) in registry.allocations)) {
      return slot;
    }
  }
  return null;
}
