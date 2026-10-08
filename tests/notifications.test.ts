import { describe, expect, test } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import { emitEntityNotifications } from '../convex/notifications';
import { put } from '../convex/access';
import { memberSchema, type Entity, type Project, type Task } from '../shared/model';

type Comment = Extract<Entity, { kind: 'comments' }>['value'];

const modules = import.meta.glob('../convex/**/*.ts');
const auth = (name: string, verified = true) => ({
  subject: `subject-${name}-sensitive`,
  issuer: 'https://test.clerk.accounts.dev',
  email: `${name}@example.com`,
  emailVerified: verified,
  name,
});
function project(id: string, owner: string, members: string[] = [owner]): Project {
  return {
    id,
    key: id.toUpperCase(),
    name: id,
    icon: 'folder',
    color: 'indigo',
    status: 'planning',
    team: '',
    lead: owner,
    due: null,
    start: null,
    fav: false,
    members,
    desc: '',
    milestones: [],
    last: 0,
  };
}
function task(id: string, projectId: string, assignee: string | null = null): Task {
  return {
    id,
    project: projectId,
    key: `${projectId.toUpperCase()}-${id}`,
    title: `Task ${id}`,
    status: 'todo',
    assignee,
    priority: 'none',
    due: null,
    start: null,
    labels: [],
    subtasks: [],
    attachments: [],
    deps: [],
    desc: '',
    estimate: null,
    created: 1,
    updated: 1,
    order: 1,
    fav: false,
    recur: null,
  };
}
function comment(id: string, taskId: string, by: string, text: string): Comment {
  return { id, task: taskId, by, at: 1, text, re: {} };
}
function operation(before: Entity | null, after: Entity | null) {
  return { before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null };
}

async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(auth('owner'));
  const workspace = await owner.mutation(api.workspaces.create, { name: 'Notifications' });
  const snapshot = await owner.query(api.workspaces.snapshot, { workspace });
  const teammateId = 'teammate';
  const teammateProfile = memberSchema.parse({
    id: teammateId,
    name: 'Teammate',
    email: 'teammate@example.com',
    role: 'Member',
    team: '',
    title: '',
    c: '#123456',
    status: 'invited',
    last: null,
    tz: '',
  });
  await owner.mutation(api.members.update, { workspace, before: null, after: JSON.stringify(teammateProfile) });
  const teammate = t.withIdentity(auth('teammate'));
  await teammate.mutation(api.workspaces.acceptInvitations, {});
  const p = project('p1', snapshot.me, [snapshot.me, teammateId]);
  const t1 = task('t1', p.id);
  await t.run(async ctx => {
    await put(ctx, workspace, { kind: 'projects', value: p });
    await put(ctx, workspace, { kind: 'tasks', value: t1 });
  });
  return { t, workspace, owner, teammate, ownerId: snapshot.me, teammateId, p, t1 };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function drainNotifications(t: Harness['t']) {
  await t.finishAllScheduledFunctions(() => undefined);
}

describe('notifications', () => {
  test('marks all unread notifications in bounded batches without consuming later arrivals', async () => {
    const h = await setup();
    const before = Date.now();
    await h.t.run(async ctx => {
      for (let i = 0; i < 1002; i++) {
        await ctx.db.insert('notifications', {
          workspace: h.workspace,
          recipient: h.teammateId,
          eventId: `event-${i}`,
          type: 'update',
          title: 'Update',
          body: '',
          readAt: null,
          createdAt: i === 1001 ? before + 1 : before,
          dedupeKey: `event-${i}`,
        });
      }
    });
    expect(await h.teammate.mutation(api.notifications.markAllRead, { workspace: h.workspace, before })).toMatchObject({ count: 1000, hasMore: true });
    expect(await h.teammate.mutation(api.notifications.markAllRead, { workspace: h.workspace, before })).toMatchObject({ count: 1, hasMore: false });
    const unread = await h.teammate.query(api.notifications.list, { workspace: h.workspace, unread: true });
    expect(unread.notifications.map(notification => notification.eventId)).toEqual(['event-1001']);
    expect((await h.owner.query(api.notifications.list, { workspace: h.workspace })).notifications).toEqual([]);
  });

  test('emits through entities.apply and persists one delivery outbox row per notification', async () => {
    const h = await setup();
    const assigned = task('t2', h.p.id, h.teammateId);
    await h.owner.mutation(api.entities.apply, { workspace: h.workspace, changes: [operation(null, { kind: 'tasks', value: assigned })] });
    await drainNotifications(h.t);

    const assignedPage = await h.teammate.query(api.notifications.list, { workspace: h.workspace });
    expect(assignedPage.notifications).toHaveLength(1);
    expect(assignedPage.notifications[0]).toMatchObject({ type: 'assign', task: assigned.id, project: h.p.id });
    expect(await h.teammate.query(api.notificationDelivery.status, { workspace: h.workspace })).toMatchObject({ pending: 1, failed: 0, sent: 0 });
    const outbox = await h.t.run(ctx =>
      ctx.db
        .query('notificationOutbox')
        .withIndex('by_workspace', q => q.eq('workspace', h.workspace))
        .collect(),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 0, notification: expect.any(String) });

    await h.teammate.mutation(api.notifications.savePreferences, { workspace: h.workspace, comments: false });
    const c = comment('c2', assigned.id, h.ownerId, '@Teammate please review this');
    await h.owner.mutation(api.entities.apply, { workspace: h.workspace, changes: [operation(null, { kind: 'comments', value: c })] });
    await drainNotifications(h.t);
    const afterComment = await h.teammate.query(api.notifications.list, { workspace: h.workspace });
    expect(afterComment.notifications.map(notification => notification.type)).toEqual(['mention', 'assign']);
    expect(await h.teammate.query(api.notificationDelivery.status, { workspace: h.workspace })).toMatchObject({ pending: 2 });
  });

  test('emits server-derived assignments, paginates, and persists read state per recipient', async () => {
    const h = await setup();
    const assigned = { ...h.t1, assignee: h.teammateId, updated: 2 };
    await h.t.run(async ctx => {
      await put(ctx, h.workspace, { kind: 'tasks', value: assigned });
      await emitEntityNotifications(ctx, h.workspace, h.ownerId, { kind: 'tasks', value: h.t1 }, { kind: 'tasks', value: assigned }, [
        { kind: 'projects', value: h.p },
        { kind: 'tasks', value: assigned },
      ]);
    });
    await drainNotifications(h.t);
    const page = await h.teammate.query(api.notifications.list, { workspace: h.workspace, limit: 1 });
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]).toMatchObject({ type: 'assign', task: h.t1.id, project: h.p.id, readAt: null });
    expect((await h.owner.query(api.notifications.list, { workspace: h.workspace })).notifications).toEqual([]);
    await h.teammate.mutation(api.notifications.setRead, { workspace: h.workspace, notification: page.notifications[0].id, read: true });
    expect((await h.teammate.query(api.notifications.list, { workspace: h.workspace, unread: true })).notifications).toEqual([]);
    await h.teammate.mutation(api.notifications.setRead, { workspace: h.workspace, notification: page.notifications[0].id, read: false });
    expect((await h.teammate.query(api.notifications.list, { workspace: h.workspace, unread: true })).notifications).toHaveLength(1);

    const c = comment('c1', h.t1.id, h.ownerId, 'A follow-up');
    await h.t.run(ctx =>
      emitEntityNotifications(ctx, h.workspace, h.ownerId, null, { kind: 'comments', value: c }, [
        { kind: 'projects', value: h.p },
        { kind: 'tasks', value: assigned },
        { kind: 'comments', value: c },
      ]),
    );
    await drainNotifications(h.t);
    const first = await h.teammate.query(api.notifications.list, { workspace: h.workspace, limit: 1 });
    expect(first.notifications[0]?.type).toBe('comment');
    expect(first.page.cursor).not.toBeNull();
    const second = await h.teammate.query(api.notifications.list, { workspace: h.workspace, limit: 1, cursor: first.page.cursor ?? undefined });
    expect(second.notifications[0]?.type).toBe('assign');
    await expect(h.teammate.query(api.notifications.list, { workspace: h.workspace, unread: true, cursor: first.page.cursor ?? undefined })).rejects.toThrow(
      'NOTIFICATION_CURSOR_INVALID',
    );
  });

  test('routes exact comment mentions, honors preferences, and rejects foreign notification IDs', async () => {
    const h = await setup();
    await h.teammate.mutation(api.notifications.savePreferences, { workspace: h.workspace, comments: false });
    const c = comment('c1', h.t1.id, h.ownerId, '@Teammate please review this');
    await h.t.run(ctx =>
      emitEntityNotifications(ctx, h.workspace, h.ownerId, null, { kind: 'comments', value: c }, [
        { kind: 'projects', value: h.p },
        { kind: 'tasks', value: h.t1 },
        { kind: 'comments', value: c },
      ]),
    );
    await drainNotifications(h.t);
    const page = await h.teammate.query(api.notifications.list, { workspace: h.workspace });
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]).toMatchObject({ type: 'mention', body: c.text });
    await expect(h.owner.mutation(api.notifications.setRead, { workspace: h.workspace, notification: page.notifications[0].id, read: true })).rejects.toThrow(
      'unavailable',
    );
    await expect(h.t.withIdentity(auth('outsider')).query(api.notifications.list, { workspace: h.workspace })).rejects.toThrow('access');
  });

  test('does not leak a private project notification after access is revoked', async () => {
    const h = await setup();
    const assigned = { ...h.t1, assignee: h.teammateId, updated: 2 };
    await h.t.run(async ctx => {
      await emitEntityNotifications(ctx, h.workspace, h.ownerId, { kind: 'tasks', value: h.t1 }, { kind: 'tasks', value: assigned }, [
        { kind: 'projects', value: h.p },
        { kind: 'tasks', value: assigned },
      ]);
      await put(ctx, h.workspace, { kind: 'projects', value: { ...h.p, private: true, members: [h.ownerId] } });
    });
    await drainNotifications(h.t);
    expect((await h.teammate.query(api.notifications.list, { workspace: h.workspace })).notifications).toEqual([]);
  });

  test('does not leak a legacy task-only notification after task project access is revoked', async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      await ctx.db.insert('notifications', {
        workspace: h.workspace,
        recipient: h.teammateId,
        eventId: 'legacy-task-only',
        type: 'update',
        task: h.t1.id,
        title: 'Private task update',
        body: 'This must not be visible after access is revoked.',
        readAt: null,
        createdAt: Date.now(),
        dedupeKey: 'legacy-task-only:teammate',
      });
      await put(ctx, h.workspace, { kind: 'projects', value: { ...h.p, private: true, members: [h.ownerId] } });
    });
    expect((await h.teammate.query(api.notifications.list, { workspace: h.workspace })).notifications).toEqual([]);
  });

  test('defers fanout and drains 500 recipients in bounded membership pages', async () => {
    const h = await setup();
    const extraIds = Array.from({ length: 498 }, (_, index) => `member-${index}`);
    const memberIds = [h.ownerId, h.teammateId, ...extraIds];
    const changed = { ...h.t1, title: 'A changed task', updated: 2 };
    await h.t.run(async ctx => {
      for (const id of extraIds) {
        await ctx.db.insert('memberships', {
          workspace: h.workspace,
          email: `${id}@example.com`,
          profile: JSON.stringify(
            memberSchema.parse({
              id,
              name: `Member ${id}`,
              email: `${id}@example.com`,
              role: 'Member',
              team: '',
              title: '',
              c: '#123456',
              status: 'active',
              last: null,
              tz: '',
            }),
          ),
        });
      }
      await put(ctx, h.workspace, { kind: 'projects', value: { ...h.p, members: memberIds } });
      await emitEntityNotifications(ctx, h.workspace, h.ownerId, { kind: 'tasks', value: h.t1 }, { kind: 'tasks', value: changed }, []);
    });
    expect(
      await h.t.run(ctx =>
        ctx.db
          .query('notifications')
          .withIndex('by_workspace', q => q.eq('workspace', h.workspace))
          .collect(),
      ),
    ).toHaveLength(0);
    expect(
      await h.t.run(ctx =>
        ctx.db
          .query('notificationEvents')
          .withIndex('by_workspace', q => q.eq('workspace', h.workspace))
          .collect(),
      ),
    ).toHaveLength(1);

    await drainNotifications(h.t);

    expect(
      await h.t.run(ctx =>
        ctx.db
          .query('notifications')
          .withIndex('by_workspace', q => q.eq('workspace', h.workspace))
          .collect(),
      ),
    ).toHaveLength(499);
    expect(
      await h.t.run(ctx =>
        ctx.db
          .query('notificationEvents')
          .withIndex('by_workspace', q => q.eq('workspace', h.workspace))
          .collect(),
      ),
    ).toHaveLength(0);
  });
});
