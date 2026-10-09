import { v } from 'convex/values';
import { z } from 'zod';
import { internal } from './_generated/api';
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { access, canRead, decode, fail } from './access';
import { enqueueNotificationDelivery } from './notificationDelivery';
import { entitySchema, memberSchema, type Entity, type Member, type Project, type Task } from '../shared/model';
import {
  defaultNotificationPreferences,
  notificationPageSchema,
  notificationPreferencesSchema,
  notificationSchema,
  notificationTypeSchema,
  type NotificationPreferences,
  type NotificationType,
} from '../shared/notifications';

const MAX_PAGE = 100;
const MAX_READ_ALL = 1_000;
const cursorEnvelopeSchema = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), position: z.string() }).strict();
const notificationType = v.union(v.literal('mention'), v.literal('assign'), v.literal('comment'), v.literal('update'));
const preferenceArgs = {
  mentions: v.optional(v.boolean()),
  assignments: v.optional(v.boolean()),
  comments: v.optional(v.boolean()),
  updates: v.optional(v.boolean()),
  email: v.optional(v.boolean()),
  push: v.optional(v.boolean()),
};

type NotificationRow = Doc<'notifications'>;

function preferencesFromRow(row: {
  mentions: boolean;
  assignments: boolean;
  comments: boolean;
  updates: boolean;
  email: boolean;
  push: boolean;
}): NotificationPreferences {
  return notificationPreferencesSchema.parse({
    mentions: row.mentions,
    assignments: row.assignments,
    comments: row.comments,
    updates: row.updates,
    email: row.email,
    push: row.push,
  });
}

async function preferenceFor(ctx: QueryCtx | MutationCtx, workspace: Id<'workspaces'>, member: string): Promise<NotificationPreferences> {
  const row = await ctx.db
    .query('notificationPreferences')
    .withIndex('by_member_workspace', q => q.eq('workspace', workspace).eq('member', member))
    .unique();
  return row ? preferencesFromRow(row) : defaultNotificationPreferences;
}

function toNotification(row: NotificationRow) {
  return notificationSchema.parse({
    id: row._id,
    eventId: row.eventId,
    type: row.type,
    actor: row.actor ?? null,
    entityKind: row.entityKind ?? null,
    entityId: row.entityId ?? null,
    project: row.project ?? null,
    task: row.task ?? null,
    title: row.title,
    body: row.body,
    readAt: row.readAt,
    createdAt: row.createdAt,
  });
}

async function cursorScope(parts: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function cursorPosition(cursor: string | undefined, scope: string): string | null {
  if (!cursor) return null;
  try {
    const parsed = cursorEnvelopeSchema.parse(JSON.parse(cursor));
    if (parsed.scope !== scope) return fail('NOTIFICATION_CURSOR_INVALID: Restart pagination with the current filter.');
    return parsed.position;
  } catch {
    return fail('NOTIFICATION_CURSOR_INVALID: Restart pagination with the current filter.');
  }
}

function pageMetadata(position: string, isDone: boolean, scope: string) {
  return { cursor: isDone ? null : JSON.stringify({ scope, position }), isDone };
}

async function visibleNotification(ctx: QueryCtx, workspace: Id<'workspaces'>, member: Member, row: NotificationRow): Promise<boolean> {
  let taskProject: string | undefined;
  if (row.task) {
    const taskRow = await ctx.db
      .query('entities')
      .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'tasks').eq('key', row.task!))
      .unique();
    if (!taskRow) return false;
    const task = decode(taskRow.payload);
    if (task.kind !== 'tasks' || task.value.id !== row.task) return false;
    taskProject = task.value.project;
    if (row.project && taskProject !== row.project) return false;
  }
  const projectId = row.project ?? taskProject;
  if (!projectId) return true;
  const projectRow = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'projects').eq('key', projectId))
    .unique();
  if (!projectRow) return false;
  const entity = decode(projectRow.payload);
  return entity.kind === 'projects' && entity.value.id === projectId && canRead(entity.value, member);
}

export const list = query({
  args: {
    workspace: v.id('workspaces'),
    unread: v.optional(v.boolean()),
    type: v.optional(notificationType),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const permission = await access(ctx, args.workspace);
    const limit = args.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return fail(`Notification limit must be an integer from 1 to ${MAX_PAGE}.`);
    const type = args.type === undefined ? undefined : notificationTypeSchema.parse(args.type);
    const scope = await cursorScope(['notifications', permission.user.tokenIdentifier, args.workspace, args.unread === true, type ?? null]);
    const cursor = cursorPosition(args.cursor, scope);
    const source =
      args.unread === true
        ? ctx.db
            .query('notifications')
            .withIndex('by_recipient_unread', q => q.eq('workspace', args.workspace).eq('recipient', permission.member.id).eq('readAt', null))
            .order('desc')
        : ctx.db
            .query('notifications')
            .withIndex('by_recipient', q => q.eq('workspace', args.workspace).eq('recipient', permission.member.id))
            .order('desc');
    const filtered = type === undefined ? source : source.filter(q => q.eq(q.field('type'), type));
    const page = await filtered.paginate({
      numItems: limit,
      cursor,
      maximumRowsRead: Math.max(limit, Math.min(500, limit * (type === undefined ? 1 : 4))),
      maximumBytesRead: 3_000_000,
    });
    const notifications = [];
    for (const row of page.page) {
      if (await visibleNotification(ctx, args.workspace, permission.member, row)) notifications.push(toNotification(row));
    }
    return notificationPageSchema.parse({
      notifications,
      page: pageMetadata(page.continueCursor, page.isDone, scope),
    });
  },
});

export const preferences = query({
  args: { workspace: v.id('workspaces') },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    return preferenceFor(ctx, args.workspace, member.id);
  },
});

export const savePreferences = mutation({
  args: { workspace: v.id('workspaces'), ...preferenceArgs },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const existing = await ctx.db
      .query('notificationPreferences')
      .withIndex('by_member_workspace', q => q.eq('workspace', args.workspace).eq('member', member.id))
      .unique();
    const previous = existing ? preferencesFromRow(existing) : defaultNotificationPreferences;
    const next = notificationPreferencesSchema.parse({
      ...previous,
      mentions: args.mentions ?? previous.mentions,
      assignments: args.assignments ?? previous.assignments,
      comments: args.comments ?? previous.comments,
      updates: args.updates ?? previous.updates,
      email: args.email ?? previous.email,
      push: args.push ?? previous.push,
    });
    const updatedAt = Date.now();
    if (existing) await ctx.db.patch(existing._id, { ...next, updatedAt });
    else await ctx.db.insert('notificationPreferences', { workspace: args.workspace, member: member.id, ...next, updatedAt });
    return next;
  },
});

async function ownedNotification(ctx: MutationCtx, workspace: Id<'workspaces'>, member: string, rawId: string): Promise<NotificationRow> {
  const id = ctx.db.normalizeId('notifications', rawId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.workspace !== workspace || row.recipient !== member) return fail('Notification is unavailable.');
  return row;
}

export const setRead = mutation({
  args: { workspace: v.id('workspaces'), notification: v.string(), read: v.boolean() },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const row = await ownedNotification(ctx, args.workspace, member.id, args.notification);
    const readAt = args.read ? (row.readAt ?? Date.now()) : null;
    if (readAt !== row.readAt) await ctx.db.patch(row._id, { readAt });
    return { readAt };
  },
});

export const markRead = mutation({
  args: { workspace: v.id('workspaces'), notification: v.string() },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const row = await ownedNotification(ctx, args.workspace, member.id, args.notification);
    const readAt = row.readAt ?? Date.now();
    if (readAt !== row.readAt) await ctx.db.patch(row._id, { readAt });
    return { readAt };
  },
});

export const markAllRead = mutation({
  args: { workspace: v.id('workspaces'), before: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const rows = await ctx.db
      .query('notifications')
      .withIndex('by_recipient_unread', q =>
        q
          .eq('workspace', args.workspace)
          .eq('recipient', member.id)
          .eq('readAt', null)
          .lte('createdAt', args.before ?? Date.now()),
      )
      .take(MAX_READ_ALL + 1);
    const readAt = Date.now();
    for (const row of rows.slice(0, MAX_READ_ALL)) await ctx.db.patch(row._id, { readAt });
    return { count: Math.min(rows.length, MAX_READ_ALL), hasMore: rows.length > MAX_READ_ALL, readAt };
  },
});

function meaningfulTaskChange(before: Task, after: Task): boolean {
  const normalize = (task: Task) => ({ ...task, updated: 0, attachments: [] });
  return JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after));
}

function mentionedMembers(text: string, members: readonly Member[]): string[] {
  return members
    .filter(member => {
      const name = member.name.trim();
      if (!name) return false;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,!?;:)\\]])`, 'iu').test(text);
    })
    .map(member => member.id);
}

function recipientIds(project: Project | undefined, members: readonly Member[], task?: Task): string[] {
  if (!project) return [];
  return members.filter(member => canRead(project, member) && (project.members.includes(member.id) || task?.assignee === member.id)).map(member => member.id);
}

function preferenceKey(type: NotificationType): keyof Pick<NotificationPreferences, 'mentions' | 'assignments' | 'comments' | 'updates'> {
  return type === 'mention' ? 'mentions' : type === 'assign' ? 'assignments' : type === 'comment' ? 'comments' : 'updates';
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

type Event = {
  type: NotificationType;
  recipients: string[];
  title: string;
  body: string;
  entity: Entity;
};

/**
 * Enqueues durable in-app events from already validated entity values. Recipient
 * fanout is deliberately deferred to a cursor-paginated internal mutation so a
 * large entity batch cannot consume the caller's transaction budget.
 */
export async function emitEntityNotifications(
  ctx: MutationCtx,
  workspace: Id<'workspaces'>,
  actor: string,
  before: Entity | null,
  after: Entity | null,
  snapshot: readonly Entity[],
  actorName?: string,
): Promise<void> {
  void snapshot;
  if (!hasNotificationPotential(before, after)) return;
  const event = await ctx.db.insert('notificationEvents', {
    workspace,
    actor,
    actorName: actorName?.trim() || actor,
    before: before ? JSON.stringify(entitySchema.parse(before)) : null,
    after: after ? JSON.stringify(entitySchema.parse(after)) : null,
    cursor: null,
    createdAt: Date.now(),
  });
  await ctx.scheduler.runAfter(0, internal.notifications.dispatchEvent, { event });
}

function hasNotificationPotential(before: Entity | null, after: Entity | null): boolean {
  const entity = after ?? before;
  if (!entity) return false;
  if (entity.kind === 'tasks') {
    if (!after || after.kind !== 'tasks') return false;
    if (!before || before.kind !== 'tasks') return after.value.assignee !== null || /@/.test(after.value.desc);
    return before.value.desc !== after.value.desc || before.value.assignee !== after.value.assignee || meaningfulTaskChange(before.value, after.value);
  }
  if (entity.kind === 'comments') return after?.kind === 'comments' && (!before || before.kind !== 'comments' || before.value.text !== after.value.text);
  if (entity.kind === 'projects') {
    return Boolean(before?.kind === 'projects' && JSON.stringify({ ...before.value, last: 0 }) !== JSON.stringify({ ...entity.value, last: 0 }));
  }
  return false;
}

type NotificationContext = {
  entity: Entity;
  project?: Project;
  task?: Task;
};

const NOTIFICATION_EVENT_MEMBER_BATCH = 25;

async function currentEntity(ctx: MutationCtx, workspace: Id<'workspaces'>, kind: Entity['kind'], id: string): Promise<Entity | undefined> {
  const row = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', kind).eq('key', id))
    .unique();
  if (!row) return undefined;
  const entity = decode(row.payload);
  return entity.kind === kind && entity.value.id === id ? entity : undefined;
}

async function currentNotificationContext(
  ctx: MutationCtx,
  workspace: Id<'workspaces'>,
  before: Entity | null,
  after: Entity | null,
): Promise<NotificationContext | undefined> {
  const entity = after ?? before;
  if (!entity || !hasNotificationPotential(before, after)) return undefined;
  if (entity.kind === 'projects') {
    const project = await currentEntity(ctx, workspace, 'projects', entity.value.id);
    return project?.kind === 'projects' ? { entity, project: project.value } : undefined;
  }
  if (entity.kind === 'tasks') {
    const task = await currentEntity(ctx, workspace, 'tasks', entity.value.id);
    if (!task || task.kind !== 'tasks' || task.value.project !== entity.value.project) return undefined;
    const project = await currentEntity(ctx, workspace, 'projects', task.value.project);
    return project?.kind === 'projects' ? { entity, project: project.value, task: task.value } : undefined;
  }
  if (entity.kind === 'comments') {
    const task = await currentEntity(ctx, workspace, 'tasks', entity.value.task);
    if (!task || task.kind !== 'tasks') return undefined;
    const project = await currentEntity(ctx, workspace, 'projects', task.value.project);
    return project?.kind === 'projects' ? { entity, project: project.value, task: task.value } : undefined;
  }
  return undefined;
}

async function writeForMembers(
  ctx: MutationCtx,
  workspace: Id<'workspaces'>,
  actor: string,
  actorName: string,
  context: NotificationContext,
  before: Entity | null,
  members: readonly Member[],
): Promise<void> {
  const { entity, project, task } = context;
  const recipients = recipientIds(project, members, task).filter(id => id !== actor);
  const events: Event[] = [];

  if (entity.kind === 'tasks' && (before?.kind !== 'tasks' || before.value.desc !== entity.value.desc)) {
    const previous = new Set(before?.kind === 'tasks' ? mentionedMembers(before.value.desc.replace(/<[^>]*>/g, ' '), members) : []);
    for (const recipient of mentionedMembers(entity.value.desc.replace(/<[^>]*>/g, ' '), members)) {
      const profile = members.find(member => member.id === recipient);
      if (recipient !== actor && !previous.has(recipient) && profile && project && canRead(project, profile)) {
        events.push({
          type: 'mention',
          recipients: [recipient],
          title: `${actorName} mentioned you in “${entity.value.title}”`,
          body: entity.value.desc.replace(/<[^>]*>/g, ' '),
          entity,
        });
      }
    }
  }

  if (
    entity.kind === 'tasks' &&
    (before === null || before.kind === 'tasks') &&
    before?.value.assignee !== entity.value.assignee &&
    entity.value.assignee &&
    entity.value.assignee !== actor &&
    task?.assignee === entity.value.assignee &&
    recipients.includes(entity.value.assignee)
  ) {
    events.push({
      type: 'assign',
      recipients: [entity.value.assignee],
      title: 'Task assigned to you',
      body: `${actorName} assigned “${entity.value.title}” to you.`,
      entity,
    });
  }

  if (entity.kind === 'comments' && (!before || before.kind !== 'comments' || before.value.text !== entity.value.text)) {
    const readable = members.filter(member => project && canRead(project, member)).map(member => member.id);
    const mentioned = new Set(mentionedMembers(entity.value.text, members).filter(id => id !== actor && readable.includes(id)));
    for (const member of mentioned) {
      events.push({ type: 'mention', recipients: [member], title: `${actorName} mentioned you`, body: entity.value.text, entity });
    }
    const commentRecipients = recipients.filter(id => !mentioned.has(id));
    if (commentRecipients.length && task) {
      events.push({ type: 'comment', recipients: commentRecipients, title: `${actorName} commented on “${task.title}”`, body: entity.value.text, entity });
    }
  }

  if (before?.kind === 'tasks' && entity.kind === 'tasks' && meaningfulTaskChange(before.value, entity.value)) {
    const assignmentOnly =
      before.value.assignee !== entity.value.assignee &&
      JSON.stringify({ ...normalizeTaskForComparison(before.value), assignee: null }) ===
        JSON.stringify({ ...normalizeTaskForComparison(entity.value), assignee: null });
    if (!assignmentOnly && recipients.length) {
      events.push({ type: 'update', recipients, title: `${actorName} updated “${entity.value.title}”`, body: 'A task you can access was updated.', entity });
    }
  }

  if (
    before?.kind === 'projects' &&
    entity.kind === 'projects' &&
    JSON.stringify({ ...before.value, last: 0 }) !== JSON.stringify({ ...entity.value, last: 0 }) &&
    recipients.length
  ) {
    events.push({ type: 'update', recipients, title: `${actorName} updated “${entity.value.name}”`, body: 'A project you can access was updated.', entity });
  }

  const now = Date.now();
  for (const event of events) {
    const version = await fingerprint(JSON.stringify({ type: event.type, body: event.body, entity: event.entity }));
    const eventId = `${event.entity.kind}:${event.entity.value.id}:${event.type}:${version}`;
    const prefs = new Map<string, NotificationPreferences>();
    for (const recipient of new Set(event.recipients)) {
      const preference = prefs.get(recipient) ?? (await preferenceFor(ctx, workspace, recipient));
      prefs.set(recipient, preference);
      if (!preference[preferenceKey(event.type)]) continue;
      const dedupeKey = `${eventId}:${recipient}`;
      const existing = await ctx.db
        .query('notifications')
        .withIndex('by_dedupe', q => q.eq('workspace', workspace).eq('recipient', recipient).eq('dedupeKey', dedupeKey))
        .unique();
      if (existing) continue;
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient,
        eventId,
        type: event.type,
        actor,
        entityKind: event.entity.kind,
        entityId: event.entity.value.id,
        ...(project ? { project: project.id } : {}),
        ...(task ? { task: task.id } : {}),
        title: event.title.slice(0, 500),
        body: event.body.slice(0, 10_000),
        readAt: null,
        createdAt: now,
        dedupeKey,
      });
      await enqueueNotificationDelivery(ctx, workspace, notification);
    }
  }
}

function normalizeTaskForComparison(task: Task): Task {
  return { ...task, updated: 0, attachments: [] };
}

export const dispatchEvent = internalMutation({
  args: { event: v.id('notificationEvents') },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.event);
    if (!job) return { done: true };
    const workspace = await ctx.db.get(job.workspace);
    if (!workspace || workspace.lifecycle === 'deleting') {
      await ctx.db.delete(job._id);
      return { done: true };
    }
    const before = job.before ? entitySchema.parse(JSON.parse(job.before)) : null;
    const after = job.after ? entitySchema.parse(JSON.parse(job.after)) : null;
    const context = await currentNotificationContext(ctx, job.workspace, before, after);
    if (!context) {
      await ctx.db.delete(job._id);
      return { done: true };
    }
    const page = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', job.workspace))
      .paginate({ numItems: NOTIFICATION_EVENT_MEMBER_BATCH, cursor: job.cursor });
    const members = page.page.map(row => memberSchema.parse(JSON.parse(row.profile))).filter(member => member.status === 'active');
    await writeForMembers(ctx, job.workspace, job.actor, job.actorName, context, before, members);
    if (page.isDone) {
      await ctx.db.delete(job._id);
      return { done: true, processed: members.length };
    }
    await ctx.db.patch(job._id, { cursor: page.continueCursor });
    await ctx.scheduler.runAfter(0, internal.notifications.dispatchEvent, { event: job._id });
    return { done: false, processed: members.length };
  },
});
