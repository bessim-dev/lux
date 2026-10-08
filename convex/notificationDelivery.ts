import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { access, canRead, decode, fail } from './access';
import { memberSchema, type Member } from '../shared/model';
import {
  deliveryEvent,
  NOTIFICATION_LEASE_MS,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_TIMEOUT_MS,
  type NotificationDeliveryEvent,
} from '../shared/notification-delivery';

const deliveryArgs = { outbox: v.id('notificationOutbox'), token: v.optional(v.string()) };
const retryArgs = { workspace: v.id('workspaces'), outbox: v.string() };
const deliveryStatus = v.union(v.literal('pending'), v.literal('failed'));

type ClaimedDelivery = { attempt: number; scheduleToken: string; event: NotificationDeliveryEvent };

function deliveryConfigured(): boolean {
  return Boolean(process.env.REOTECH_NOTIFICATIONS_URL?.trim() && process.env.REOTECH_NOTIFICATIONS_SERVICE_KEY?.trim());
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  const message = error instanceof Error ? error.message : '';
  const status = /http[_ ](\d{3})/i.exec(message)?.[1];
  return status ? `http_${status}` : 'network_error';
}

function retryDelay(attempt: number): number {
  return Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function errorCategory(error: string | undefined): 'timeout' | 'http' | 'network' | null {
  if (!error) return null;
  if (error === 'timeout') return 'timeout';
  if (error.startsWith('http_')) return 'http';
  return 'network';
}

function publicError(error: string | undefined): string | null {
  if (!error) return null;
  const category = errorCategory(error);
  if (category === 'http') return /^http_\d{3}$/.test(error) ? error : 'http_error';
  return category;
}

async function retryOne(ctx: MutationCtx, row: Doc<'notificationOutbox'>): Promise<boolean> {
  if (row.status === 'sent') return false;
  if (row.status === 'pending' && row.attempts > 0 && row.nextAttemptAt > Date.now()) return false;
  const now = Date.now();
  const scheduleToken = crypto.randomUUID();
  await ctx.db.patch(row._id, {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    updatedAt: now,
    lastError: undefined,
    scheduleToken,
  });
  if (deliveryConfigured()) await ctx.scheduler.runAfter(0, internal.notificationDelivery.dispatch, { outbox: row._id, token: scheduleToken });
  return true;
}

/** Insert the local outbox record in the same transaction as the native notification. */
export async function enqueueNotificationDelivery(
  ctx: MutationCtx,
  workspace: Id<'workspaces'>,
  notification: Id<'notifications'>,
): Promise<Id<'notificationOutbox'> | null> {
  const row = await ctx.db.get(notification);
  if (!row || row.workspace !== workspace) return null;
  const existing = await ctx.db
    .query('notificationOutbox')
    .withIndex('by_notification', q => q.eq('notification', notification))
    .unique();
  if (existing) return existing._id;
  const now = Date.now();
  const scheduleToken = crypto.randomUUID();
  const outbox = await ctx.db.insert('notificationOutbox', {
    workspace,
    notification,
    idempotencyKey: row.dedupeKey,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    scheduleToken,
  });
  if (deliveryConfigured()) await ctx.scheduler.runAfter(0, internal.notificationDelivery.dispatch, { outbox, token: scheduleToken });
  return outbox;
}

export const claim = internalMutation({
  args: deliveryArgs,
  handler: async (ctx, args): Promise<ClaimedDelivery | null> => {
    const row = await ctx.db.get(args.outbox);
    const now = Date.now();
    if (row && (args.token === undefined ? row.scheduleToken !== undefined : row.scheduleToken !== args.token)) return null;
    if (!row || row.status === 'sent' || row.attempts >= NOTIFICATION_MAX_ATTEMPTS || row.nextAttemptAt > now) return null;
    const notification = await ctx.db.get(row.notification);
    if (!notification) {
      await ctx.db.patch(row._id, { status: 'sent', updatedAt: now, nextAttemptAt: now, lastError: undefined, scheduleToken: undefined });
      return null;
    }
    const workspace = await ctx.db.get(row.workspace);
    if (!workspace || workspace.lifecycle === 'deleting' || notification.workspace !== row.workspace) {
      await ctx.db.patch(row._id, { status: 'sent', updatedAt: now, nextAttemptAt: now, lastError: undefined, scheduleToken: undefined });
      return null;
    }
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', row.workspace))
      .take(500);
    const membership = memberships.find(candidate => {
      const member = memberSchema.parse(JSON.parse(candidate.profile));
      return member.id === notification.recipient && member.status === 'active';
    });
    if (!membership) {
      await ctx.db.patch(row._id, { status: 'sent', updatedAt: now, nextAttemptAt: now, lastError: undefined, scheduleToken: undefined });
      return null;
    }
    const member = memberSchema.parse(JSON.parse(membership.profile));
    let projectId = notification.project;
    if (notification.task) {
      const taskRow = await ctx.db
        .query('entities')
        .withIndex('by_key', q => q.eq('workspace', row.workspace).eq('kind', 'tasks').eq('key', notification.task!))
        .unique();
      const task = taskRow ? decode(taskRow.payload) : null;
      if (!task || task.kind !== 'tasks' || (projectId && task.value.project !== projectId)) {
        await ctx.db.patch(row._id, { status: 'sent', updatedAt: now, nextAttemptAt: now, lastError: undefined, scheduleToken: undefined });
        return null;
      }
      projectId ??= task.value.project;
    }
    if (projectId) {
      const projectRow = await ctx.db
        .query('entities')
        .withIndex('by_key', q => q.eq('workspace', row.workspace).eq('kind', 'projects').eq('key', projectId!))
        .unique();
      if (!projectRow) {
        await ctx.db.patch(row._id, { status: 'sent', updatedAt: now, nextAttemptAt: now, lastError: undefined, scheduleToken: undefined });
        return null;
      }
      const project = decode(projectRow.payload);
      if (project.kind !== 'projects' || !canRead(project.value, member)) {
        await ctx.db.patch(row._id, { status: 'sent', updatedAt: now, nextAttemptAt: now, lastError: undefined, scheduleToken: undefined });
        return null;
      }
    }
    const attempt = row.attempts + 1;
    const leaseUntil = now + NOTIFICATION_LEASE_MS;
    const scheduleToken = crypto.randomUUID();
    await ctx.db.patch(row._id, { status: 'pending', attempts: attempt, nextAttemptAt: leaseUntil, updatedAt: now, lastError: undefined, scheduleToken });
    await ctx.scheduler.runAt(leaseUntil, internal.notificationDelivery.dispatch, { outbox: row._id, token: scheduleToken });
    return {
      attempt,
      scheduleToken,
      event: deliveryEvent({
        notificationId: notification._id,
        workspace: row.workspace,
        eventId: notification.eventId,
        idempotencyKey: row.idempotencyKey,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        recipient: notification.recipient,
        createdAt: notification.createdAt,
        project: projectId,
        task: notification.task,
      }),
    };
  },
});

export const markSent = internalMutation({
  args: { outbox: v.id('notificationOutbox'), attempt: v.number(), token: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outbox);
    if (!row || row.status !== 'pending' || row.attempts !== args.attempt || row.scheduleToken !== args.token) return false;
    await ctx.db.patch(row._id, { status: 'sent', nextAttemptAt: Date.now(), updatedAt: Date.now(), lastError: undefined, scheduleToken: undefined });
    return true;
  },
});

export const markFailed = internalMutation({
  args: { outbox: v.id('notificationOutbox'), attempt: v.number(), token: v.string(), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outbox);
    if (!row || row.status !== 'pending' || row.attempts !== args.attempt || row.scheduleToken !== args.token) return null;
    const now = Date.now();
    if (args.attempt >= NOTIFICATION_MAX_ATTEMPTS) {
      await ctx.db.patch(row._id, { status: 'failed', nextAttemptAt: now, updatedAt: now, lastError: args.error.slice(0, 500), scheduleToken: undefined });
      return null;
    }
    const nextAttemptAt = now + retryDelay(args.attempt);
    const scheduleToken = crypto.randomUUID();
    await ctx.db.patch(row._id, { status: 'failed', nextAttemptAt, updatedAt: now, lastError: args.error.slice(0, 500), scheduleToken });
    return { nextAttemptAt, token: scheduleToken };
  },
});

export const dispatch = internalAction({
  args: deliveryArgs,
  handler: async (ctx, args): Promise<{ status: 'disabled' | 'skipped' | 'sent' | 'retrying' | 'failed' }> => {
    if (!deliveryConfigured()) return { status: 'disabled' };
    const claimed = await ctx.runMutation(internal.notificationDelivery.claim, args);
    if (!claimed) return { status: 'skipped' };
    const serviceUrl = process.env.REOTECH_NOTIFICATIONS_URL!.trim().replace(/\/$/, '');
    const serviceKey = process.env.REOTECH_NOTIFICATIONS_SERVICE_KEY!.trim();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NOTIFICATION_TIMEOUT_MS);
    try {
      const response = await fetch(`${serviceUrl}/v1/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(claimed.event),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      await ctx.runMutation(internal.notificationDelivery.markSent, { outbox: args.outbox, attempt: claimed.attempt, token: claimed.scheduleToken });
      return { status: 'sent' };
    } catch (error) {
      const nextAttemptAt = await ctx.runMutation(internal.notificationDelivery.markFailed, {
        outbox: args.outbox,
        attempt: claimed.attempt,
        token: claimed.scheduleToken,
        error: safeError(error),
      });
      if (nextAttemptAt !== null && deliveryConfigured()) {
        await ctx.scheduler.runAt(nextAttemptAt.nextAttemptAt, internal.notificationDelivery.dispatch, { outbox: args.outbox, token: nextAttemptAt.token });
        return { status: 'retrying' };
      }
      return { status: 'failed' };
    } finally {
      clearTimeout(timeout);
    }
  },
});

export const status = query({
  args: { workspace: v.id('workspaces') },
  handler: async (ctx, args) => {
    await access(ctx, args.workspace);
    const [pending, failed, sent] = await Promise.all(
      (['pending', 'failed', 'sent'] as const).map(status =>
        ctx.db
          .query('notificationOutbox')
          .withIndex('by_workspace_status', q => q.eq('workspace', args.workspace).eq('status', status))
          .take(501),
      ),
    );
    return {
      configured: deliveryConfigured(),
      pending: Math.min(pending.length, 500),
      failed: Math.min(failed.length, 500),
      sent: Math.min(sent.length, 500),
      hasMore: pending.length > 500 || failed.length > 500 || sent.length > 500,
    };
  },
});

async function notificationTitle(
  ctx: QueryCtx,
  workspace: Id<'workspaces'>,
  row: Doc<'notificationOutbox'>,
  members: Map<string, Member>,
  inspector: Member,
): Promise<string | null> {
  const notification = await ctx.db.get(row.notification);
  if (!notification || notification.workspace !== workspace) return null;
  const member = members.get(notification.recipient);
  if (!member || member.status !== 'active') return null;
  let projectId = notification.project;
  if (notification.task) {
    const taskRow = await ctx.db
      .query('entities')
      .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'tasks').eq('key', notification.task!))
      .unique();
    const task = taskRow ? decode(taskRow.payload) : null;
    if (!task || task.kind !== 'tasks' || (projectId && task.value.project !== projectId)) return null;
    projectId ??= task.value.project;
  }
  if (!projectId) return notification.title;
  const projectRow = await ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'projects').eq('key', projectId!))
    .unique();
  if (!projectRow) return null;
  const project = decode(projectRow.payload);
  return project.kind === 'projects' && canRead(project.value, member) && canRead(project.value, inspector) ? notification.title : null;
}

export const list = query({
  args: {
    workspace: v.id('workspaces'),
    status: v.optional(deliveryStatus),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { admin, member: inspector } = await access(ctx, args.workspace);
    if (!admin) return fail('Only workspace admins can inspect notification delivery.');
    const limit = args.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail('Delivery limit must be an integer from 1 to 100.');
    const membershipRows = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(501);
    const members = new Map<string, Member>(
      membershipRows.map(row => {
        const member = memberSchema.parse(JSON.parse(row.profile));
        return [member.id, member];
      }),
    );
    const page = args.status
      ? await ctx.db
          .query('notificationOutbox')
          .withIndex('by_workspace_status', q => q.eq('workspace', args.workspace).eq('status', args.status!))
          .order('desc')
          .paginate({ numItems: limit, cursor: args.cursor ?? null, maximumRowsRead: Math.max(limit, limit * 2), maximumBytesRead: 1_000_000 })
      : await ctx.db
          .query('notificationOutbox')
          .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
          .filter(q => q.or(q.eq(q.field('status'), 'pending'), q.eq(q.field('status'), 'failed')))
          .order('desc')
          .paginate({ numItems: limit, cursor: args.cursor ?? null, maximumRowsRead: Math.max(100, limit * 4), maximumBytesRead: 1_000_000 });
    const items = await Promise.all(
      page.page.map(async row => ({
        id: row._id,
        attempts: row.attempts,
        error: publicError(row.lastError),
        category: errorCategory(row.lastError),
        nextAttemptAt: row.nextAttemptAt,
        title: await notificationTitle(ctx, args.workspace, row, members, inspector),
      })),
    );
    return { items, page: { cursor: page.isDone ? null : page.continueCursor, isDone: page.isDone } };
  },
});

export const retry = mutation({
  args: retryArgs,
  handler: async (ctx, args) => {
    const { admin } = await access(ctx, args.workspace);
    if (!admin) return fail('Only workspace admins can retry notification delivery.');
    const id = ctx.db.normalizeId('notificationOutbox', args.outbox);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.workspace !== args.workspace) return fail('Notification delivery is unavailable.');
    if (row.status === 'sent') return fail('Notification delivery is already complete.');
    if (row.status === 'pending' && row.attempts > 0 && row.nextAttemptAt > Date.now()) return fail('Notification delivery is currently in progress.');
    if (!(await retryOne(ctx, row))) return fail('Notification delivery is currently in progress.');
    return { status: 'pending' as const };
  },
});

export const retryQueued = mutation({
  args: { workspace: v.id('workspaces') },
  handler: async (ctx, args) => {
    const { admin } = await access(ctx, args.workspace);
    if (!admin) return fail('Only workspace admins can retry notification delivery.');
    if (!deliveryConfigured()) return { configured: false, count: 0, hasMore: false };
    const [pending, failed] = await Promise.all(
      (['pending', 'failed'] as const).map(status =>
        ctx.db
          .query('notificationOutbox')
          .withIndex('by_workspace_status', q => q.eq('workspace', args.workspace).eq('status', status))
          .take(501),
      ),
    );
    const now = Date.now();
    const candidates = [...pending, ...failed]
      .filter(row => row.attempts < NOTIFICATION_MAX_ATTEMPTS && row.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    const hasMore = pending.length === 501 || failed.length === 501 || candidates.length > 50;
    let count = 0;
    for (const row of candidates.slice(0, 50)) if (await retryOne(ctx, row)) count += 1;
    return { configured: true, count, hasMore };
  },
});
