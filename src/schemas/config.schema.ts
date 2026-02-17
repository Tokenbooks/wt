import { z } from 'zod';

const PATCH_TYPES = ['database', 'redis', 'port', 'url'] as const;

/** Schema for a single env var patch rule */
export const patchSchema = z.object({
  var: z.string().min(1),
  type: z.enum(PATCH_TYPES),
  service: z.string().optional(),
});

/** Schema for a service with a default port */
export const serviceSchema = z.object({
  name: z.string().min(1),
  defaultPort: z.number().int().positive(),
});

/** Schema for an env file to copy and patch */
export const envFileSchema = z.object({
  source: z.string().min(1),
  patches: z.array(patchSchema),
});

/** Schema for wt.config.json */
export const configSchema = z.object({
  baseDatabaseName: z.string().min(1),
  baseWorktreePath: z.string().min(1).default('.worktrees'),
  portStride: z.number().int().positive().default(100),
  maxSlots: z.number().int().min(1).max(15).default(15),
  services: z.array(serviceSchema).min(1),
  envFiles: z.array(envFileSchema),
  postSetup: z.array(z.string()).default([]),
  autoInstall: z.boolean().default(true),
});
