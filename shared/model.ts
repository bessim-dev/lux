import { z } from 'zod';

const text = z.string().max(10000);
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const named = { id, name: z.string().trim().min(1).max(200) };
export const roleSchema = z.enum(['Owner', 'Admin', 'Member', 'Guest']);
export const memberSchema = z.object({
  ...named,
  email: z.email().max(320),
  role: roleSchema,
  team: text,
  title: text,
  c: color,
  status: z.enum(['active', 'invited']),
  last: z.number().nullable(),
  tz: text,
});
export const workspaceSchema = z.object({ name: named.name, url: text, c: color, brand: z.boolean().optional() });
export const attachmentSchema = z.object({
  ...named,
  type: z.enum(['fig', 'pdf', 'zip', 'img', 'sheet', 'doc', 'code', 'other', 'file']),
  size: z.string().regex(/^\d+(\.\d+)? (B|KB|MB|GB)$/),
  by: id,
  at: z.number(),
});
export const projectSchema = z.object({
  ...named,
  key: z.string().regex(/^[A-Z0-9-]{1,30}$/),
  icon: z.string().regex(/^[a-z0-9-]+$/),
  color: z.string().regex(/^[a-z]+$/),
  status: z.enum(['planning', 'active', 'hold', 'complete', 'risk']),
  team: text,
  lead: id.nullable(),
  due: date,
  start: date,
  fav: z.boolean(),
  members: z.array(id).max(500),
  desc: text,
  milestones: z.array(z.object({ name: text, date })).max(500),
  last: z.number(),
  private: z.boolean().optional(),
  archived: z.boolean().optional(),
  archivedAt: z.number().optional(),
  seq: z.number().optional(),
  access: z.enum(['workspace', 'private', 'link']).optional(),
  perms: z.record(id, z.enum(['Can edit', 'Can view', 'Full access', 'Can comment'])).optional(),
});
const status = z.enum(['backlog', 'todo', 'progress', 'review', 'done']);
export const taskSchema = z.object({
  id,
  project: id,
  key: text,
  title: z.string().trim().min(1).max(500),
  status,
  assignee: id.nullable(),
  priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
  due: date,
  start: date,
  labels: z.array(text).max(100),
  subtasks: z.array(z.object({ id, title: text, done: z.boolean(), assignee: id.nullable().optional(), due: date.optional(), note: text.optional() })).max(500),
  attachments: z.array(attachmentSchema).max(100),
  deps: z.array(id).max(500),
  desc: z.string().max(100000),
  estimate: text.nullable(),
  created: z.number(),
  updated: z.number(),
  order: z.number(),
  fav: z.boolean(),
  recur: z.enum(['Daily', 'Weekly', 'Every 2 weeks', 'Monthly']).nullable(),
  archived: z.boolean().optional(),
  archivedAt: z.number().optional(),
  completedAt: z.number().optional(),
  prevStatus: status.optional(),
});
export const commentSchema = z.object({ id, task: id, by: id, at: z.number(), text, re: z.record(z.string(), z.array(id).max(500)) });
export const activitySchema = z.object({ id, by: id, verb: text, task: id.nullable(), project: id.nullable(), at: z.number(), extra: text });
export const fileSchema = attachmentSchema.extend({ project: id, task: id.nullable().optional() });
export const teamSchema = z.object({ ...named, desc: text, icon: z.string().regex(/^[a-z0-9-]+$/), c: color });
export const eventSchema = z.object({ id, title: text, date, time: text, project: id });
export const viewSchema = z.object({
  ...named,
  project: id,
  type: text,
  filters: z.array(z.object({ f: text, op: text, v: z.array(z.union([text, z.number()])) })).max(100),
});
export const entitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('projects'), value: projectSchema }),
  z.object({ kind: z.literal('tasks'), value: taskSchema }),
  z.object({ kind: z.literal('comments'), value: commentSchema }),
  z.object({ kind: z.literal('activity'), value: activitySchema }),
  z.object({ kind: z.literal('files'), value: fileSchema }),
  z.object({ kind: z.literal('teams'), value: teamSchema }),
  z.object({ kind: z.literal('events'), value: eventSchema }),
  z.object({ kind: z.literal('savedViews'), value: viewSchema }),
]);
export type Entity = z.infer<typeof entitySchema>;
export type Member = z.infer<typeof memberSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export const collections = ['projects', 'tasks', 'comments', 'activity', 'files', 'teams', 'events', 'savedViews'] as const;
export const dataSchema = z.object({
  ws: workspaceSchema,
  me: z.string(),
  members: z.array(memberSchema),
  projects: z.array(projectSchema),
  tasks: z.array(taskSchema),
  comments: z.array(commentSchema),
  activity: z.array(activitySchema),
  files: z.array(fileSchema),
  teams: z.array(teamSchema),
  events: z.array(eventSchema),
  savedViews: z.array(viewSchema),
});
export type Data = z.infer<typeof dataSchema>;
export const emptyData = (): Data => ({
  ws: { name: 'Your workspace', url: '', c: '#1D1C1A' },
  me: '',
  members: [],
  projects: [],
  tasks: [],
  comments: [],
  activity: [],
  files: [],
  teams: [],
  events: [],
  savedViews: [],
});
export function entities(data: Data): Entity[] {
  return collections.flatMap(kind => data[kind].map(value => entitySchema.parse({ kind, value })));
}
export function entityKey(entity: Entity): string {
  return `${entity.kind}:${entity.value.id}`;
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aa = Object.entries(a),
      bb = Object.entries(b);
    return aa.length === bb.length && aa.every(([k, v]) => equal(v, Reflect.get(b, k)));
  }
  return false;
}
export type Change = { before: Entity | null; after: Entity | null };
export function changes(before: Entity[], after: Entity[]): Change[] {
  const old = new Map(before.map(e => [entityKey(e), e]));
  const next = new Map(after.map(e => [entityKey(e), e]));
  return [...new Set([...old.keys(), ...next.keys()])].flatMap(key => {
    const a = old.get(key) ?? null,
      b = next.get(key) ?? null;
    return equal(a, b) ? [] : [{ before: a, after: b }];
  });
}
