import { v } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { access, canEdit, canRead, decode, fail } from './access';
import { MAX_PULL_REQUEST_LINKS, parsePullRequestUrl, type PullRequestReference } from '../shared/pull-requests';

async function taskAccess(ctx: QueryCtx, workspace: Id<'workspaces'>, task: string) {
  const { member } = await access(ctx, workspace);
  const row = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'tasks').eq('key', task))
    .unique();
  const entity = row && decode(row.payload);
  if (!entity || entity.kind !== 'tasks') return fail('Task is unavailable.');
  const projectRow = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'projects').eq('key', entity.value.project))
    .unique();
  const project = projectRow && decode(projectRow.payload);
  if (!project || project.kind !== 'projects' || !canRead(project.value, member)) return fail('Task is unavailable.');
  return { member, project: project.value, canEdit: canEdit(project.value, member) };
}

export const list = query({
  args: { workspace: v.id('workspaces'), task: v.string() },
  handler: async (ctx, args) => {
    const permission = await taskAccess(ctx, args.workspace, args.task);
    const rows = await ctx.db
      .query('pullRequestLinks')
      .withIndex('by_task', q => q.eq('workspace', args.workspace).eq('task', args.task))
      .take(MAX_PULL_REQUEST_LINKS);
    return {
      canEdit: permission.canEdit,
      links: rows.map(row => ({
        id: row._id,
        provider: row.provider,
        host: row.host,
        owner: row.owner,
        repository: row.repository,
        number: row.number,
        url: row.url,
        createdAt: row.createdAt,
      })),
    };
  },
});

export const add = mutation({
  args: { workspace: v.id('workspaces'), task: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    const permission = await taskAccess(ctx, args.workspace, args.task);
    if (!permission.canEdit) return fail('You do not have permission to edit this project.');
    let reference: PullRequestReference;
    try {
      reference = parsePullRequestUrl(args.url);
    } catch {
      return fail('Use an HTTPS GitHub or Forgejo pull request URL without credentials.');
    }
    const rows = await ctx.db
      .query('pullRequestLinks')
      .withIndex('by_task', q => q.eq('workspace', args.workspace).eq('task', args.task))
      .take(MAX_PULL_REQUEST_LINKS);
    const existing = rows.find(row => row.url === reference.url);
    if (existing) return existing._id;
    if (rows.length >= MAX_PULL_REQUEST_LINKS) return fail(`A task can have at most ${MAX_PULL_REQUEST_LINKS} pull request links.`);
    return ctx.db.insert('pullRequestLinks', {
      ...reference,
      workspace: args.workspace,
      project: permission.project.id,
      task: args.task,
      createdBy: permission.member.id,
      createdAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { workspace: v.id('workspaces'), task: v.string(), link: v.string() },
  handler: async (ctx, args) => {
    const permission = await taskAccess(ctx, args.workspace, args.task);
    if (!permission.canEdit) return fail('You do not have permission to edit this project.');
    const id = ctx.db.normalizeId('pullRequestLinks', args.link);
    if (!id) return fail('Pull request link is unavailable.');
    const link = await ctx.db.get(id);
    if (!link) return; // Retrying removal is safe.
    if (link.workspace !== args.workspace || link.task !== args.task || link.project !== permission.project.id)
      return fail('Pull request link is unavailable.');
    await ctx.db.delete(id);
  },
});
