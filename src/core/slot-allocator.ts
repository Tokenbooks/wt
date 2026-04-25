import * as net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ServiceConfig, Registry } from '../types';

const execFileAsync = promisify(execFile);

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
 * Validate that generated ports stay within range and never collide across
 * the main worktree (slot 0) and configured worktree slots.
 */
export function validatePortPlan(
  services: readonly ServiceConfig[],
  maxSlots: number,
  stride: number,
): void {
  const seen = new Map<number, string>();

  for (let slot = 0; slot <= maxSlots; slot++) {
    for (const service of services) {
      const port = slot * stride + service.defaultPort;
      if (port > 65535) {
        throw new Error(
          `Port ${port} for service '${service.name}' in slot ${slot} exceeds 65535. ` +
          'Reduce maxSlots, portStride, or the default port.',
        );
      }

      const owner = `slot ${slot} (${service.name})`;
      const existing = seen.get(port);
      if (existing) {
        throw new Error(
          `Port ${port} collides between ${existing} and ${owner}. ` +
          'Adjust service default ports or increase portStride.',
        );
      }
      seen.set(port, owner);
    }
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();

    const finish = (available: boolean) => {
      server.removeAllListeners();
      resolve(available);
    };

    server.once('error', () => finish(false));
    server.once('listening', () => {
      server.close(() => finish(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function findUnavailableServicePorts(
  ports: Record<string, number>,
): Promise<Array<{ service: string; port: number }>> {
  const entries = Object.entries(ports);
  const checks = await Promise.all(
    entries.map(async ([service, port]) => ({
      service,
      port,
      available: await isPortAvailable(port),
    })),
  );

  return checks
    .filter((item) => !item.available)
    .map(({ service, port }) => ({ service, port }));
}

export async function findAvailablePortSafeSlot(
  registry: Registry,
  maxSlots: number,
  services: readonly ServiceConfig[],
  stride: number,
): Promise<number | null> {
  for (let slot = 1; slot <= maxSlots; slot++) {
    if (String(slot) in registry.allocations) {
      continue;
    }

    const ports = calculatePorts(slot, services, stride);
    const unavailable = await findUnavailableServicePorts(ports);
    if (unavailable.length === 0) {
      return slot;
    }
  }

  return null;
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

/**
 * Parse the output of `lsof -F pcn`. Returns the first listener's pid +
 * command, or null if the input doesn't contain a complete listener record.
 */
export function parseLsofOutput(output: string): { pid: number; command: string } | null {
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      // Encountering a new pid before completing the previous record means
      // the previous record was incomplete; reset.
      if (pid !== null && command === null) {
        pid = null;
      }
      const parsed = Number(line.slice(1));
      if (Number.isInteger(parsed)) {
        pid = parsed;
      }
    } else if (line.startsWith('c') && pid !== null && command === null) {
      command = line.slice(1);
    }
    if (pid !== null && command !== null) {
      return { pid, command };
    }
  }
  return null;
}

/**
 * Best-effort identification of the process listening on `port`. Returns
 * `<command>[<pid>]` on darwin/linux when lsof finds a listener; returns
 * `"unknown process"` on any failure (no listener, lsof missing, parse
 * failure, unsupported platform). Never throws.
 */
export async function describeListener(port: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pcn'],
      { timeout: 2000 },
    );
    const parsed = parseLsofOutput(stdout);
    if (parsed) {
      return `${parsed.command}[${parsed.pid}]`;
    }
  } catch {
    // lsof returns non-zero when no match is found, or is missing entirely.
  }
  return 'unknown process';
}
