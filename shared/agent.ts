import { z } from 'zod';
import { memberSchema, projectSchema, taskSchema } from './model';

export const AGENT_MAX_DESCRIPTION = 10000;
export const AGENT_MAX_PR_REFERENCES = 50;
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
const pageInput = {
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(16000).optional(),
};
export const agentContextRequestSchema = z
  .object({
    workspace: id.optional(),
    project: id.optional(),
    ...pageInput,
  })
  .strict()
  .refine(value => !value.project || !!value.workspace, 'A project requires an explicit workspace.');
export const agentSearchRequestSchema = z
  .object({
    workspace: id,
    project: id,
    query: z.string().trim().max(200).optional(),
    status: taskSchema.shape.status.optional(),
    assignee: id.nullable().optional(),
    ...pageInput,
  })
  .strict();
export const agentGetRequestSchema = z
  .object({
    workspace: id,
    project: id,
    task: z.union([z.object({ id }).strict(), z.object({ key: z.string().min(1).max(10000) }).strict()]),
    includeDescription: z.boolean().default(false),
  })
  .strict();
export const agentWorkspaceSchema = z.object({ id, name: z.string() }).strict();
export const agentProjectSchema = projectSchema.pick({ id: true, key: true, name: true }).strict();
export const agentMemberSchema = memberSchema.pick({ id: true, role: true }).strict();
export const agentSelectionSchema = z
  .object({
    workspace: agentWorkspaceSchema,
    project: agentProjectSchema,
    member: agentMemberSchema,
  })
  .strict();
export const agentPageSchema = z.object({ cursor: z.string().nullable(), isDone: z.boolean() }).strict();
export const agentTaskSummarySchema = taskSchema
  .pick({
    id: true,
    key: true,
    title: true,
    status: true,
    assignee: true,
    priority: true,
    due: true,
    updated: true,
  })
  .strict();
export const agentContextResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspaces'), workspaces: z.array(agentWorkspaceSchema).max(50), page: agentPageSchema }).strict(),
  z
    .object({
      kind: z.literal('projects'),
      workspace: agentWorkspaceSchema,
      member: agentMemberSchema,
      projects: z.array(agentProjectSchema).max(50),
      page: agentPageSchema,
    })
    .strict(),
  z.object({ kind: z.literal('selection'), selection: agentSelectionSchema }).strict(),
]);
export const agentSearchResponseSchema = z.object({ tasks: z.array(agentTaskSummarySchema).max(50), page: agentPageSchema }).strict();
export const agentPullRequestSchema = z
  .object({
    id: z.string(),
    provider: z.enum(['github', 'forgejo']),
    host: z.string(),
    owner: z.string(),
    repository: z.string(),
    number: z.number(),
    url: z.string(),
    createdAt: z.number(),
  })
  .strict();
export const agentGetResponseSchema = z
  .object({
    task: agentTaskSummarySchema,
    description: z.string().max(AGENT_MAX_DESCRIPTION).optional(),
    descriptionTruncated: z.boolean().optional(),
    pullRequests: z.array(agentPullRequestSchema).max(AGENT_MAX_PR_REFERENCES),
  })
  .strict();
export type AgentContextRequest = z.input<typeof agentContextRequestSchema>;
export type AgentContextResponse = z.infer<typeof agentContextResponseSchema>;
export type AgentSearchRequest = z.input<typeof agentSearchRequestSchema>;
export type AgentSearchResponse = z.infer<typeof agentSearchResponseSchema>;
export type AgentGetRequest = z.input<typeof agentGetRequestSchema>;
export type AgentGetResponse = z.infer<typeof agentGetResponseSchema>;
export type AgentSelection = z.infer<typeof agentSelectionSchema>;
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>;
