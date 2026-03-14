import { z } from 'zod';

const PATCH_TYPES = ['database', 'redis', 'port', 'url', 'branch'] as const;

/** Schema for a single env var patch rule */
export const patchSchema = z.discriminatedUnion('type', [
  z.object({
    var: z.string().min(1),
    type: z.literal(PATCH_TYPES[0]),
  }),
  z.object({
    var: z.string().min(1),
    type: z.literal(PATCH_TYPES[1]),
    service: z.string().min(1),
  }),
  z.object({
    var: z.string().min(1),
    type: z.literal(PATCH_TYPES[2]),
    service: z.string().min(1),
  }),
  z.object({
    var: z.string().min(1),
    type: z.literal(PATCH_TYPES[3]),
    service: z.string().min(1),
  }),
  z.object({
    var: z.string().min(1),
    type: z.literal(PATCH_TYPES[4]),
  }),
]);

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
  maxSlots: z.number().int().min(1).default(50),
  services: z.array(serviceSchema).min(1),
  envFiles: z.array(envFileSchema),
  postSetup: z.array(z.string()).default([]),
  autoInstall: z.boolean().default(true),
});
