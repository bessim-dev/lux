import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { agentMetadata, decode, fail } from './access';

const NAME = 'tasks-v1' as const;
// Internal operators can recover the committed checkpoint after a lost response.
export const status = internalQuery({
  args: {},
  handler: async ctx => {
    const state = await ctx.db
      .query('agentIndexState')
      .withIndex('by_name', q => q.eq('name', NAME))
      .unique();
    return state ? { status: state.status, cursor: state.cursor, processed: state.processed } : { status: 'not_started' as const, cursor: null, processed: 0 };
  },
});
export async function requireAgentIndex(ctx: QueryCtx) {
  const state = await ctx.db
    .query('agentIndexState')
    .withIndex('by_name', q => q.eq('name', NAME))
    .unique();
  if (state?.status !== 'ready') {
    fail(
      'AGENT_INDEX_NOT_READY: An operator must run internal.agentIndex.start, then internal.agentIndex.backfill with its returned cursor until status is ready. Recover a lost checkpoint with internal.agentIndex.status.',
    );
  }
}

// Internal only. A singleton state serializes starts and batches through Convex OCC.
// A rejected batch leaves its cursor unchanged; repair the invalid row and resume.
export const start = internalMutation({
  args: {},
  handler: async ctx => {
    const state = await ctx.db
      .query('agentIndexState')
      .withIndex('by_name', q => q.eq('name', NAME))
      .unique();
    if (state) return fail('AGENT_INDEX_ALREADY_STARTED: Resume the existing cursor; restarting is not allowed.');
    await ctx.db.insert('agentIndexState', { name: NAME, status: 'running', cursor: null, processed: 0 });
    return { status: 'running' as const, cursor: null, processed: 0 };
  },
});
export const backfill = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) return fail('Backfill limit must be an integer from 1 to 25.');
    const state = await ctx.db
      .query('agentIndexState')
      .withIndex('by_name', q => q.eq('name', NAME))
      .unique();
    if (!state || state.status !== 'running') return fail('AGENT_INDEX_NOT_RUNNING: Start once, then resume the existing cursor.');
    if (args.cursor !== state.cursor) return fail('AGENT_INDEX_STALE_CURSOR: Use the latest returned cursor.');
    const page = await ctx.db.query('entities').paginate({ numItems: limit, cursor: state.cursor, maximumRowsRead: limit, maximumBytesRead: 3000000 });
    for (const row of page.page) {
      const entity = decode(row.payload);
      if (entity.kind !== row.kind || entity.value.id !== row.key)
        return fail('AGENT_INDEX_INVALID_ENTITY: Stored entity kind/key does not match its validated payload.');
      await ctx.db.patch(row._id, agentMetadata(entity));
    }
    const result = {
      status: page.isDone ? ('ready' as const) : ('running' as const),
      cursor: page.isDone ? null : page.continueCursor,
      processed: state.processed + page.page.length,
    };
    await ctx.db.patch(state._id, result);
    return result;
  },
});
