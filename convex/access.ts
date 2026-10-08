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
  const memberships = await ctx.db
    .query('memberships')
    .withIndex('by_identity', q => q.eq('identity', user.tokenIdentifier))
    .collect();
  const row = memberships.find(m => m.workspace === workspace);
  if (!row) return fail('You do not have access to this workspace.');
  const member = memberSchema.parse(JSON.parse(row.profile));
  return { user, row, member, admin: member.role === 'Owner' || member.role === 'Admin' };
}
export async function allEntities(ctx: QueryCtx, workspace: Id<'workspaces'>) {
  return ctx.db
    .query('entities')
    .withIndex('by_workspace', q => q.eq('workspace', workspace))
    .collect();
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
export async function put(ctx: MutationCtx, workspace: Id<'workspaces'>, entity: Entity) {
  const row = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', entity.kind).eq('key', entity.value.id))
    .unique();
  const payload = JSON.stringify(entity);
  if (row) await ctx.db.patch(row._id, { payload });
  else await ctx.db.insert('entities', { workspace, kind: entity.kind, key: entity.value.id, payload });
}
export function decode(payload: string): Entity {
  return entitySchema.parse(JSON.parse(payload));
}
