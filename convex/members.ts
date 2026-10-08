import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { access, fail, allEntities, decode, put } from './access';
import { memberSchema, equal } from '../shared/model';

export const update = mutation({
  args: { workspace: v.id('workspaces'), before: v.union(v.string(), v.null()), after: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const { member, admin } = await access(ctx, args.workspace);
    const before = args.before ? memberSchema.parse(JSON.parse(args.before)) : null;
    const after = args.after ? memberSchema.parse(JSON.parse(args.after)) : null;
    if (!before && !after) return fail('Missing member.');
    const id = (before || after)!.id;
    if (after && after.id !== id) return fail('Member ID cannot change.');
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .collect();
    const row = rows.find(r => memberSchema.parse(JSON.parse(r.profile)).id === id);
    const current = row ? memberSchema.parse(JSON.parse(row.profile)) : null;
    if (!equal(before, current)) return fail('This member changed. Reload and try again.');
    if (!admin) {
      if (!before || !after || id !== member.id || !equal({ ...before, name: after.name, title: after.title, tz: after.tz }, after))
        return fail('Only admins can manage members.');
    }
    if (before?.role === 'Owner' && (!after || after.role !== 'Owner')) return fail('The workspace owner cannot be removed or demoted.');
    if (after?.role === 'Owner' && before?.role !== 'Owner') return fail('Ownership cannot be granted here.');
    if (after) {
      if (before && (before.email !== after.email || before.status !== after.status)) return fail('Email and account status are managed by authentication.');
      if (!before && after.status !== 'invited') return fail('New members must accept an invitation.');
      const email = after.email.toLowerCase();
      if (rows.some(r => r.email === email && r._id !== row?._id)) return fail('This email is already a member or invited.');
      const profile = JSON.stringify({ ...after, email });
      if (row) await ctx.db.patch(row._id, { profile });
      else await ctx.db.insert('memberships', { workspace: args.workspace, email, profile });
    } else if (row) {
      await ctx.db.delete(row._id);
      for (const record of await allEntities(ctx, args.workspace)) {
        const entity = decode(record.payload);
        if (entity.kind === 'projects') {
          entity.value.members = entity.value.members.filter(mid => mid !== id);
          if (entity.value.perms) delete entity.value.perms[id];
          if (entity.value.lead === id) entity.value.lead = null;
          await put(ctx, args.workspace, entity);
        } else if (entity.kind === 'tasks' && entity.value.assignee === id) {
          entity.value.assignee = null;
          await put(ctx, args.workspace, entity);
        }
      }
    }
  },
});
