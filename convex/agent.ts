import { v } from 'convex/values';
import { z } from 'zod';
import { query, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { access, canRead, decode, fail, identity } from './access';
import { requireAgentIndex } from './agentIndex';
import {
  AGENT_MAX_DESCRIPTION,
  AGENT_MAX_PR_REFERENCES,
  agentContextRequestSchema,
  agentContextResponseSchema,
  agentSearchRequestSchema,
  agentSearchResponseSchema,
  agentGetRequestSchema,
  agentGetResponseSchema,
  agentTaskSummarySchema,
  type AgentContextResponse,
} from '../shared/agent';

const cursorSchema = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), position: z.string() }).strict();
async function cursorScope(parts: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function cursorPosition(cursor: string | undefined, scope: string): string | null {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.parse(JSON.parse(cursor));
    if (parsed.scope !== scope) return fail('AGENT_CURSOR_INVALID: Cursor belongs to a different selection or filter.');
    return parsed.position;
  } catch {
    return fail('AGENT_CURSOR_INVALID: Restart pagination with the current selection and filters.');
  }
}
function pageMetadata(position: string, isDone: boolean, scope: string) {
  return { cursor: isDone ? null : JSON.stringify({ scope, position }), isDone };
}
async function selection(ctx: QueryCtx, workspace: Id<'workspaces'>, project: string) {
  const permission = await access(ctx, workspace);
  const w = await ctx.db.get(workspace);
  const row = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'projects').eq('key', project))
    .unique();
  const entity = row && decode(row.payload);
  if (!w || !entity || entity.kind !== 'projects' || entity.value.id !== project || !canRead(entity.value, permission.member))
    return fail('Project is unavailable.');
  return {
    workspace: { id: w._id, name: w.name },
    project: { id: entity.value.id, key: entity.value.key, name: entity.value.name },
    member: { id: permission.member.id, role: permission.member.role },
    permission,
  };
}
const pageArgs = { limit: v.optional(v.number()), cursor: v.optional(v.string()) };
export const context = query({
  args: { workspace: v.optional(v.id('workspaces')), project: v.optional(v.string()), ...pageArgs },
  handler: async (ctx, args): Promise<AgentContextResponse> => {
    const input = agentContextRequestSchema.parse(args);
    const user = await identity(ctx);
    if (!args.workspace) {
      const scope = await cursorScope(['context', user.tokenIdentifier]);
      const position = cursorPosition(input.cursor, scope);
      const anchorId = position === null ? null : ctx.db.normalizeId('memberships', position);
      const anchor = anchorId && (await ctx.db.get(anchorId));
      if (position !== null && (!anchor || anchor.identity !== user.tokenIdentifier)) {
        return fail('AGENT_CURSOR_INVALID: The continuation anchor changed. Restart pagination.');
      }
      // Native identity-index cursors can encode identity index keys. Return only
      // a storage row anchor and the scope digest to keep the principal private.
      const rows = await ctx.db
        .query('memberships')
        .withIndex('by_identity_workspace', q => {
          const range = q.eq('identity', user.tokenIdentifier);
          return anchor ? range.gt('workspace', anchor.workspace) : range;
        })
        .take(input.limit + 1);
      const workspaces = [];
      const page = rows.slice(0, input.limit);
      for (const membership of page) {
        const w = await ctx.db.get(membership.workspace);
        if (w) workspaces.push({ id: w._id, name: w.name });
      }
      return agentContextResponseSchema.parse({
        kind: 'workspaces',
        workspaces,
        page: pageMetadata(page.at(-1)?._id ?? '', rows.length <= input.limit, scope),
      });
    }
    if (input.project) {
      if (input.cursor) return fail('AGENT_CURSOR_INVALID: A selection does not accept a pagination cursor.');
      const selected = await selection(ctx, args.workspace, input.project);
      return agentContextResponseSchema.parse({
        kind: 'selection',
        selection: { workspace: selected.workspace, project: selected.project, member: selected.member },
      });
    }
    const { member } = await access(ctx, args.workspace);
    const w = await ctx.db.get(args.workspace);
    if (!w) return fail('Workspace is unavailable.');
    const scope = await cursorScope(['context', user.tokenIdentifier, args.workspace]);
    const position = cursorPosition(input.cursor, scope);
    const workspace = args.workspace;
    // Continue from a storage row anchor. Never serialize a skipped project's
    // immutable entity ID or key into a caller-visible cursor.
    const anchorId = position === null ? null : ctx.db.normalizeId('entities', position);
    const anchor = anchorId && (await ctx.db.get(anchorId));
    if (position !== null && (!anchor || anchor.workspace !== workspace || anchor.kind !== 'projects')) {
      return fail('AGENT_CURSOR_INVALID: The continuation anchor changed. Restart pagination.');
    }
    const rows = ctx.db.query('entities').withIndex('by_workspace_kind', q => {
      const range = q.eq('workspace', workspace).eq('kind', 'projects');
      return anchor ? range.gt('key', anchor.key) : range;
    });
    const projects = [];
    let scanned = 0;
    let last = position ?? '';
    let isDone = true;
    // Scan at most 100 projects plus one lookahead; retain authorized summaries only.
    // A sparse page may have a continuation so scanning remains bounded.
    for await (const row of rows) {
      if (scanned === 100) {
        isDone = false;
        break;
      }
      const entity = decode(row.payload);
      if (entity.kind !== 'projects' || entity.value.id !== row.key) return fail('Project is unavailable.');
      const readable = canRead(entity.value, member);
      if (readable && projects.length === input.limit) {
        isDone = false;
        break;
      }
      scanned++;
      last = row._id;
      if (readable) projects.push({ id: entity.value.id, key: entity.value.key, name: entity.value.name });
    }
    return agentContextResponseSchema.parse({
      kind: 'projects',
      workspace: { id: w._id, name: w.name },
      member: { id: member.id, role: member.role },
      projects,
      page: pageMetadata(last, isDone, scope),
    });
  },
});
const status = v.union(v.literal('backlog'), v.literal('todo'), v.literal('progress'), v.literal('review'), v.literal('done'));
export const search = query({
  args: {
    workspace: v.id('workspaces'),
    project: v.string(),
    query: v.optional(v.string()),
    status: v.optional(status),
    assignee: v.optional(v.union(v.string(), v.null())),
    ...pageArgs,
  },
  handler: async (ctx, args) => {
    const input = agentSearchRequestSchema.parse(args);
    const selected = await selection(ctx, args.workspace, input.project);
    await requireAgentIndex(ctx);
    const scope = await cursorScope([
      'search',
      selected.permission.user.tokenIdentifier,
      args.workspace,
      input.project,
      input.query || '',
      input.status ?? null,
      input.assignee === undefined ? ['all'] : input.assignee,
    ]);
    const options = { numItems: input.limit, cursor: cursorPosition(input.cursor, scope), maximumRowsRead: input.limit, maximumBytesRead: 3000000 };
    const tasks = input.query
      ? ctx.db.query('entities').withSearchIndex('search_tasks', q => {
          let filter = q
            .search('searchText', input.query ?? '')
            .eq('workspace', args.workspace)
            .eq('kind', 'tasks')
            .eq('project', input.project);
          if (input.status !== undefined) filter = filter.eq('status', input.status);
          if (input.assignee !== undefined) filter = filter.eq('assignee', input.assignee);
          return filter;
        })
      : input.status === undefined && input.assignee !== undefined
        ? ctx.db
            .query('entities')
            .withIndex('by_project_assignee', q =>
              q.eq('workspace', args.workspace).eq('kind', 'tasks').eq('project', input.project).eq('assignee', input.assignee),
            )
        : ctx.db.query('entities').withIndex('by_project', q => {
            const range = q.eq('workspace', args.workspace).eq('kind', 'tasks').eq('project', input.project);
            if (input.status === undefined) return range;
            const byStatus = range.eq('status', input.status);
            return input.assignee === undefined ? byStatus : byStatus.eq('assignee', input.assignee);
          });
    const page = await tasks.paginate(options);
    const summaries = page.page.map(row => {
      const entity = decode(row.payload);
      if (entity.kind !== 'tasks' || entity.value.project !== input.project || entity.value.id !== row.key) return fail('Task is unavailable.');
      return agentTaskSummarySchema.parse({
        id: entity.value.id,
        key: entity.value.key,
        title: entity.value.title,
        status: entity.value.status,
        assignee: entity.value.assignee,
        priority: entity.value.priority,
        due: entity.value.due,
        updated: entity.value.updated,
      });
    });
    return agentSearchResponseSchema.parse({ tasks: summaries, page: pageMetadata(page.continueCursor, page.isDone, scope) });
  },
});
export const get = query({
  args: {
    workspace: v.id('workspaces'),
    project: v.string(),
    task: v.union(v.object({ id: v.string() }), v.object({ key: v.string() })),
    includeDescription: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const input = agentGetRequestSchema.parse(args);
    await selection(ctx, args.workspace, input.project);
    await requireAgentIndex(ctx);
    const reference = input.task;
    const row =
      'id' in reference
        ? await ctx.db
            .query('entities')
            .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'tasks').eq('key', reference.id))
            .unique()
        : await ctx.db
            .query('entities')
            .withIndex('by_task_key', q => q.eq('workspace', args.workspace).eq('kind', 'tasks').eq('project', input.project).eq('taskKey', reference.key))
            .unique();
    const entity = row && decode(row.payload);
    if (!entity || entity.kind !== 'tasks' || entity.value.project !== input.project || entity.value.id !== row?.key) return fail('Task is unavailable.');
    const task = entity.value;
    const links = await ctx.db
      .query('pullRequestLinks')
      .withIndex('by_task', q => q.eq('workspace', args.workspace).eq('task', task.id))
      .filter(q => q.eq(q.field('project'), input.project))
      .take(AGENT_MAX_PR_REFERENCES);
    return agentGetResponseSchema.parse({
      task: {
        id: task.id,
        key: task.key,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        priority: task.priority,
        due: task.due,
        updated: task.updated,
      },
      ...(input.includeDescription
        ? { description: task.desc.slice(0, AGENT_MAX_DESCRIPTION), descriptionTruncated: task.desc.length > AGENT_MAX_DESCRIPTION }
        : {}),
      pullRequests: links.map(link => ({
        id: link._id,
        provider: link.provider,
        host: link.host,
        owner: link.owner,
        repository: link.repository,
        number: link.number,
        url: link.url,
        createdAt: link.createdAt,
      })),
    });
  },
});
