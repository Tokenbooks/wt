import type { z } from 'zod';
import type {
  configSchema,
  serviceSchema,
  envFileSchema,
  patchSchema,
  dockerServiceSchema,
} from './schemas/config.schema';
import type {
  registrySchema,
  allocationSchema,
} from './schemas/registry.schema';

/** Declarative config loaded from wt.config.json */
export type WtConfig = z.infer<typeof configSchema>;
export type ServiceConfig = z.infer<typeof serviceSchema>;
export type EnvFileConfig = z.infer<typeof envFileSchema>;
export type PatchConfig = z.infer<typeof patchSchema>;
export type DockerServiceConfig = z.infer<typeof dockerServiceSchema>;

/** Registry persisted at .worktree-registry.json */
export type Registry = z.infer<typeof registrySchema>;
export type Allocation = z.infer<typeof allocationSchema>;

/** Context passed to env patcher with computed values for a slot */
export interface PatchContext {
  readonly dbName: string;
  readonly ports: Record<string, number>;
  readonly branchName?: string;
}

/** A single service whose port had to drift away from its natural slot port */
export interface PortDrift {
  readonly service: string;
  readonly requested: number;
  readonly assigned: number;
  readonly conflict:
    | { readonly kind: 'os'; readonly description: string }
    | { readonly kind: 'internal'; readonly slot: number; readonly service: string };
}

/** Result of allocating ports for a single slot's services */
export interface AllocatedPorts {
  readonly ports: Record<string, number>;
  readonly drifts: readonly PortDrift[];
}

/** Result of CLI operations for --json output */
export interface CliResult<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: { code: string; message: string };
}
