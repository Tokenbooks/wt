import type { z } from 'zod';
import type {
  configSchema,
  serviceSchema,
  envFileSchema,
  patchSchema,
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

/** Registry persisted at .worktree-registry.json */
export type Registry = z.infer<typeof registrySchema>;
export type Allocation = z.infer<typeof allocationSchema>;

/** Context passed to env patcher with computed values for a slot */
export interface PatchContext {
  readonly dbName: string;
  readonly redisDb: number;
  readonly ports: Record<string, number>;
}

/** Result of CLI operations for --json output */
export interface CliResult<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: { code: string; message: string };
}
