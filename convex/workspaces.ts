import { v } from 'convex/values';
import { query, mutation } from './_generated/server';
import { access, identity, fail, allEntities, decode, canRead, projectOf } from './access';
import { emptyData, memberSchema, workspaceSchema } from '../shared/model';

export const list = query({
  args: {},
  handler: async ctx => {
    const user = await identity(ctx);
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_identity', q => q.eq('identity', user.tokenIdentifier))
      .collect();
    return (
      await Promise.all(
        rows.map(async m => {
          const w = await ctx.db.get(m.workspace);
          return w ? { id: w._id, name: w.name, c: w.c, plan: 'Team' } : null;
        }),
      )
    ).filter(w => w !== null);
  },
});

// An invitation grants access only after the matching verified identity claims it.
export const acceptInvitations = mutation({
  args: {},
  handler: async ctx => {
    const user = await identity(ctx);
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_email', q => q.eq('email', user.email))
      .collect();
    for (const row of rows) {
      if (row.identity) continue;
      const profile = memberSchema.parse(JSON.parse(row.profile));
      await ctx.db.patch(row._id, {
        identity: user.tokenIdentifier,
        profile: JSON.stringify({ ...profile, status: 'active', name: user.name || profile.name }),
      });
    }
  },
});
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const user = await identity(ctx);
    const name = workspaceSchema.shape.name.parse(args.name);
    const rows = await ctx.db
      .query('memberships')
      .withIndex('by_identity', q => q.eq('identity', user.tokenIdentifier))
      .collect();
    if (rows.length >= 20) return fail('Workspace limit reached.');
    const workspace = await ctx.db.insert('workspaces', {
      name,
      url: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      c: '#1D1C1A',
      owner: user.tokenIdentifier,
    });
    const member = memberSchema.parse({
      id: crypto.randomUUID(),
      email: user.email,
      name: user.name || user.email,
      role: 'Owner',
      team: '',
      title: '',
      c: '#5A67D8',
      status: 'active',
      last: 0,
      tz: '',
    });
    await ctx.db.insert('memberships', { workspace, email: user.email, identity: user.tokenIdentifier, profile: JSON.stringify(member) });
    return workspace;
  },
});
export const snapshot = query({
  args: { workspace: v.id('workspaces') },
  handler: async (ctx, { workspace }) => {
    const { member } = await access(ctx, workspace);
    const w = await ctx.db.get(workspace);
    if (!w) return fail('Workspace no longer exists.');
    const rows = await allEntities(ctx, workspace);
    const items = rows.map(r => decode(r.payload));
    const visible = items.filter(e => e.kind === 'teams' || (projectOf(e, items) && canRead(projectOf(e, items)!, member)));
    const members = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', workspace))
      .collect();
    const data = emptyData();
    data.ws = { name: w.name, url: w.url, c: w.c };
    data.me = member.id;
    data.members = members.map(m => memberSchema.parse(JSON.parse(m.profile)));
    for (const e of visible) {
      switch (e.kind) {
        case 'projects':
          data.projects.push(e.value);
          break;
        case 'tasks':
          data.tasks.push(e.value);
          break;
        case 'comments':
          data.comments.push(e.value);
          break;
        case 'activity':
          data.activity.push(e.value);
          break;
        case 'files':
          data.files.push(e.value);
          break;
        case 'teams':
          data.teams.push(e.value);
          break;
        case 'events':
          data.events.push(e.value);
          break;
        case 'savedViews':
          data.savedViews.push(e.value);
          break;
      }
    }
    for (const task of data.tasks)
      task.attachments = data.files.filter(f => f.task === task.id).map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, by: f.by, at: f.at }));
    data.activity.sort((a, b) => b.at - a.at);
    return data;
  },
});
export const update = mutation({
  args: { workspace: v.id('workspaces'), before: v.string(), after: v.string() },
  handler: async (ctx, args) => {
    const { admin } = await access(ctx, args.workspace);
    if (!admin) return fail('Only workspace admins can change workspace settings.');
    const before = workspaceSchema.parse(JSON.parse(args.before));
    const after = workspaceSchema.parse(JSON.parse(args.after));
    const w = await ctx.db.get(args.workspace);
    if (!w || w.name !== before.name || w.url !== before.url || w.c !== before.c) return fail('Workspace settings changed. Reload and try again.');
    await ctx.db.patch(args.workspace, { name: after.name, url: after.url, c: after.c });
  },
});
