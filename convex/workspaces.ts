import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, query, mutation } from './_generated/server';
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
          return w && w.lifecycle !== 'deleting' ? { id: w._id, name: w.name, c: w.c, brand: w.brand, plan: 'Team' } : null;
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
      brand: false,
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
    data.ws = { name: w.name, url: w.url, c: w.c, brand: w.brand };
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
    if (!w || w.name !== before.name || w.url !== before.url || w.c !== before.c || w.brand !== before.brand)
      return fail('Workspace settings changed. Reload and try again.');
    await ctx.db.patch(args.workspace, { name: after.name, url: after.url, c: after.c, brand: after.brand });
  },
});

export const deleteWorkspace = mutation({
  args: { workspace: v.id('workspaces'), name: v.string() },
  handler: async (ctx, args) => {
    const user = await identity(ctx);
    const workspace = await ctx.db.get(args.workspace);
    if (!workspace) return fail('Workspace no longer exists.');
    if (workspace.lifecycle === 'deleting') return fail('Workspace deletion is already in progress.');
    if (workspace.owner !== user.tokenIdentifier) return fail('Only the workspace owner can delete this workspace.');
    if (workspace.name !== args.name) return fail('Workspace name does not match.');
    const membership = await ctx.db
      .query('memberships')
      .withIndex('by_identity_workspace', q => q.eq('identity', user.tokenIdentifier).eq('workspace', args.workspace))
      .unique();
    if (!membership) return fail('You do not have access to this workspace.');
    const member = memberSchema.parse(JSON.parse(membership.profile));
    if (member.role !== 'Owner') return fail('Only the workspace owner can delete this workspace.');
    await ctx.db.patch(args.workspace, { lifecycle: 'deleting' });
    await ctx.scheduler.runAfter(0, internal.workspaces.cleanup, { workspace: args.workspace });
    return { status: 'deleting' as const };
  },
});

const CLEANUP_BATCH = 50;

export const cleanup = internalMutation({
  args: { workspace: v.id('workspaces') },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspace);
    if (!workspace || workspace.lifecycle !== 'deleting') return { status: 'done' as const };

    const importRecords = await ctx.db
      .query('importRecords')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of importRecords) await ctx.db.delete(row._id);

    const notifications = await ctx.db
      .query('notifications')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of notifications) await ctx.db.delete(row._id);

    const notificationEvents = await ctx.db
      .query('notificationEvents')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of notificationEvents) await ctx.db.delete(row._id);

    const preferences = await ctx.db
      .query('notificationPreferences')
      .withIndex('by_member_workspace', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of preferences) await ctx.db.delete(row._id);

    const outbox = await ctx.db
      .query('notificationOutbox')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of outbox) await ctx.db.delete(row._id);

    const uploads = await ctx.db
      .query('uploads')
      .withIndex('by_workspace_file', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of uploads) {
      const references = await ctx.db
        .query('uploads')
        .withIndex('by_storage', q => q.eq('storage', row.storage))
        .take(2);
      await ctx.db.delete(row._id);
      if (references.length === 1 && references[0]?._id === row._id) await ctx.storage.delete(row.storage);
    }

    const entities = await ctx.db
      .query('entities')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of entities) await ctx.db.delete(row._id);

    const counters = await ctx.db
      .query('counters')
      .withIndex('by_project', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of counters) await ctx.db.delete(row._id);

    const links = await ctx.db
      .query('pullRequestLinks')
      .withIndex('by_task', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of links) await ctx.db.delete(row._id);

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(CLEANUP_BATCH);
    for (const row of memberships) await ctx.db.delete(row._id);

    const pending =
      (await ctx.db
        .query('importRecords')
        .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('notifications')
        .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('notificationEvents')
        .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('notificationPreferences')
        .withIndex('by_member_workspace', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('notificationOutbox')
        .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('uploads')
        .withIndex('by_workspace_file', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('entities')
        .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('counters')
        .withIndex('by_project', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('pullRequestLinks')
        .withIndex('by_task', q => q.eq('workspace', args.workspace))
        .first()) ||
      (await ctx.db
        .query('memberships')
        .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
        .first());
    if (pending) {
      await ctx.scheduler.runAfter(0, internal.workspaces.cleanup, { workspace: args.workspace });
      return { status: 'scheduled' as const };
    }
    await ctx.db.delete(args.workspace);
    return { status: 'done' as const };
  },
});
