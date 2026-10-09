import { z } from 'zod';
import { projectSchema, taskSchema, commentSchema } from './model';

export const importEntitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projects'), value: projectSchema }),
  z.object({ kind: z.literal('tasks'), value: taskSchema }),
  z.object({ kind: z.literal('comments'), value: commentSchema }),
]);
export const importBatchSchema = z.object({
  provider: z.enum(['plane', 'github']),
  namespace: z.string().min(1).max(300),
  records: z
    .array(z.object({ sourceId: z.string().min(1).max(160), entity: importEntitySchema, raw: z.string().max(200000) }))
    .min(1)
    .max(25),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;
