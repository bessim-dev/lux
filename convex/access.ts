import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { entitySchema, memberSchema, type Entity, type Member, type Project } from '../shared/model';

export const fail = (message: string): never => {
  throw new ConvexError(message);
};
export async function identity(ctx: QueryCtx) {
  const user = await ctx.auth.getUserIdentity();
  if (!user || !user.email || user.emailVerified !== true) return fail('Sign in with a verified email address.');
  return { ...user, email: user.email.toLowerCase() };
}
export async function access(ctx: QueryCtx, workspace: Id<'workspaces'>) {
  const user = await identity(ctx);
  const ws = await ctx.db.get(workspace);
  if (!ws || ws.lifecycle === 'deleting') return fail('Workspace no longer exists.');
  const row = await ctx.db
    .query('memberships')
    .withIndex('by_identity_workspace', q => q.eq('identity', user.tokenIdentifier).eq('workspace', workspace))
    .unique();
  if (!row) return fail('You do not have access to this workspace.');
  const member = memberSchema.parse(JSON.parse(row.profile));
  return { user, row, member, admin: member.role === 'Owner' || member.role === 'Admin' };
}
export async function allEntities(ctx: QueryCtx, workspace: Id<'workspaces'>) {
  const rows = await ctx.db
    .query('entities')
    .withIndex('by_workspace', q => q.eq('workspace', workspace))
    .take(5001);
  if (rows.length > 5000)
    return fail('This workspace exceeds the legacy overview limit of 5000 records. Use the paginated project APIs before importing more records.');
  return rows;
}
export async function entityRow(ctx: QueryCtx, workspace: Id<'workspaces'>, kind: Entity['kind'], key: string) {
  return ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', kind).eq('key', key))
    .unique();
}
export function canRead(project: Project, member: Member): boolean {
  if (member.role === 'Guest') return project.members.includes(member.id);
  return !(project.access === 'private' || (!project.access && project.private)) || project.members.includes(member.id);
}
export function canEdit(project: Project, member: Member): boolean {
  if (!canRead(project, member)) return false;
  if (project.lead === member.id) return true;
  const permission = project.perms?.[member.id];
  if (permission) return permission === 'Can edit' || permission === 'Full access';
  return member.role !== 'Guest';
}
export function requirePrivateProjectManager(project: Project, members: Member[]) {
  if (!(project.access === 'private' || (!project.access && project.private))) return;
  const manager = members.some(
    member =>
      canEdit(project, member) &&
      (member.role === 'Owner' || member.role === 'Admin' || project.lead === member.id || project.perms?.[member.id] === 'Full access'),
  );
  if (!manager) fail('Private projects must retain at least one member who can manage access. Assign a new lead before removing the last manager.');
}
export function projectOf(entity: Entity, items: Entity[]): Project | undefined {
  if (entity.kind === 'projects') return entity.value;
  const pid = entity.kind === 'comments' ? items.find(e => e.kind === 'tasks' && e.value.id === entity.value.task) : undefined;
  const projectId = pid?.kind === 'tasks' ? pid.value.project : 'project' in entity.value ? entity.value.project : null;
  return items.find((e): e is Extract<Entity, { kind: 'projects' }> => e.kind === 'projects' && e.value.id === projectId)?.value;
}
// Derived solely from validated stored entity data, never caller identity or permissions.
export function agentMetadata(entity: Entity) {
  return entity.kind === 'tasks'
    ? { project: entity.value.project, taskKey: entity.value.key, status: entity.value.status, assignee: entity.value.assignee, searchText: entity.value.title }
    : { project: undefined, taskKey: undefined, status: undefined, assignee: undefined, searchText: '' };
}
export async function put(ctx: MutationCtx, workspace: Id<'workspaces'>, entity: Entity) {
  entity = entitySchema.parse(entity);
  const row = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', entity.kind).eq('key', entity.value.id))
    .unique();
  const payload = JSON.stringify(entity);
  const metadata = agentMetadata(entity);
  if (row) await ctx.db.patch(row._id, { payload, ...metadata });
  else await ctx.db.insert('entities', { workspace, kind: entity.kind, key: entity.value.id, payload, ...metadata });
}
export function decode(payload: string): Entity {
  return entitySchema.parse(JSON.parse(payload));
}
