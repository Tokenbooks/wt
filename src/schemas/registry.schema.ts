import { z } from 'zod';

/** Schema for a single worktree allocation */
export const allocationSchema = z.object({
  worktreePath: z.string().min(1),
  branchName: z.string().min(1),
  dbName: z.string().min(1),
  docker: z.object({
    projectName: z.string().min(1),
    services: z.array(z.string().min(1)),
  }).optional(),
  ports: z.record(z.string(), z.number().int().positive()),
  createdAt: z.string().datetime(),
});

/** Schema for .worktree-registry.json */
export const registrySchema = z.object({
  version: z.literal(1),
  allocations: z.record(z.string(), allocationSchema),
});
