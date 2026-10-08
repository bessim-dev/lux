import { describe, expect, test } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../convex/schema';
import { api, internal } from '../convex/_generated/api';
import { enqueueNotificationDelivery } from '../convex/notificationDelivery';
import { deliveryEvent, truncateUtf8 } from '../shared/notification-delivery';

const modules = import.meta.glob('../convex/**/*.ts');
const auth = (name: string) => ({
  subject: name,
  issuer: 'https://test.clerk.accounts.dev',
  email: `${name}@example.com`,
  emailVerified: true,
  name,
});

describe('notification delivery', () => {
  test('keeps title and body within the service UTF-8 byte limits', () => {
    const title = truncateUtf8('é'.repeat(200), 180);
    const event = deliveryEvent({
      notificationId: 'notification1',
      workspace: 'workspace1',
      eventId: 'event1',
      idempotencyKey: 'event1:member1',
      type: 'comment',
      title,
      body: '🙂'.repeat(2_000),
      recipient: 'member1',
      createdAt: 1,
    });
    expect(new TextEncoder().encode(event.title).length).toBeLessThanOrEqual(180);
    expect(new TextEncoder().encode(event.body).length).toBeLessThanOrEqual(2_000);
    expect(event).toMatchObject({
      externalEventId: 'event1:member1',
      kind: 'lux.notification.comment',
      recipients: [{ tenant: 'lux:workspace1', subject: 'member:member1' }],
    });
    expect(event).not.toHaveProperty('action');
  });

  test('enqueues each native notification once and keeps status safe for members', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    const snapshot = await owner.query(api.workspaces.snapshot, { workspace });
    const result = await t.mutation(async ctx => {
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient: snapshot.me,
        eventId: 'event1',
        type: 'comment',
        title: 'A comment',
        body: 'A comment was added.',
        readAt: null,
        createdAt: 1,
        dedupeKey: 'event1:member1',
      });
      const first = await enqueueNotificationDelivery(ctx, workspace, notification);
      const second = await enqueueNotificationDelivery(ctx, workspace, notification);
      return { first, second };
    });
    expect(result.first).toBe(result.second);
    expect(await owner.query(api.notificationDelivery.status, { workspace })).toMatchObject({ pending: 1, failed: 0, sent: 0 });
    expect(await owner.query(api.notificationDelivery.list, { workspace, status: 'pending' })).toMatchObject({
      items: [{ attempts: 0, title: 'A comment', category: null }],
    });
    await expect(t.withIdentity(auth('outsider')).query(api.notificationDelivery.status, { workspace })).rejects.toThrow('access');
  });

  test('does not expose a private project title to an admin who is not a project member', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    const snapshot = await owner.query(api.workspaces.snapshot, { workspace });
    const outbox = await t.run(async ctx => {
      await ctx.db.insert('memberships', {
        workspace,
        email: 'recipient@example.com',
        identity: 'recipient',
        profile: JSON.stringify({
          id: 'recipient',
          email: 'recipient@example.com',
          name: 'Recipient',
          role: 'Member',
          team: '',
          title: '',
          c: '#5A67D8',
          status: 'active',
          last: 0,
          tz: '',
        }),
      });
      await ctx.db.insert('entities', {
        workspace,
        kind: 'projects',
        key: 'private',
        payload: JSON.stringify({
          kind: 'projects',
          value: {
            id: 'private',
            key: 'PRV',
            name: 'Private',
            icon: 'folder',
            color: 'indigo',
            status: 'planning',
            team: '',
            lead: null,
            due: null,
            start: null,
            fav: false,
            members: ['recipient'],
            desc: '',
            milestones: [],
            last: 0,
            access: 'private',
          },
        }),
      });
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient: 'recipient',
        eventId: 'event-private-title',
        type: 'update',
        project: 'private',
        title: 'Private title',
        body: 'Private body',
        readAt: null,
        createdAt: 1,
        dedupeKey: 'event-private-title:recipient',
      });
      return ctx.db.insert('notificationOutbox', {
        workspace,
        notification,
        idempotencyKey: 'event-private-title:recipient',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    expect(await owner.query(api.notificationDelivery.list, { workspace, status: 'pending' })).toMatchObject({ items: [{ title: null }] });
    expect(snapshot.me).not.toBe('recipient');
    expect(outbox).toBeTruthy();
  });

  test('skips stale private notifications before external delivery', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    const snapshot = await owner.query(api.workspaces.snapshot, { workspace });
    const project = await t.run(ctx =>
      ctx.db.insert('entities', {
        workspace,
        kind: 'projects',
        key: 'private',
        payload: JSON.stringify({
          kind: 'projects',
          value: {
            id: 'private',
            key: 'PRV',
            name: 'Private',
            icon: 'folder',
            color: 'indigo',
            status: 'planning',
            team: '',
            lead: null,
            due: null,
            start: null,
            fav: false,
            members: [],
            desc: '',
            milestones: [],
            last: 0,
            access: 'private',
          },
        }),
      }),
    );
    expect(project).toBeTruthy();
    const outbox = await t.run(async ctx => {
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient: snapshot.me,
        eventId: 'event-private',
        type: 'update',
        project: 'private',
        title: 'Private update',
        body: 'Do not deliver this after access changed.',
        readAt: null,
        createdAt: 1,
        dedupeKey: 'event-private:owner',
      });
      return ctx.db.insert('notificationOutbox', {
        workspace,
        notification,
        idempotencyKey: 'event-private:owner',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await expect(t.mutation(internal.notificationDelivery.claim, { outbox })).resolves.toBeNull();
    expect((await t.run(ctx => ctx.db.get(outbox)))?.status).toBe('sent');
  });

  test('leaves queued events untouched when Reotech Notifications configuration is absent', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    const outbox = await t.run(async ctx => {
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient: 'member1',
        eventId: 'event1',
        type: 'update',
        title: 'Queued',
        body: 'Waiting for the notification service.',
        readAt: null,
        createdAt: 1,
        dedupeKey: 'event1:member1',
      });
      return ctx.db.insert('notificationOutbox', {
        workspace,
        notification,
        idempotencyKey: 'event1:member1',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const url = process.env.REOTECH_NOTIFICATIONS_URL;
    const key = process.env.REOTECH_NOTIFICATIONS_SERVICE_KEY;
    delete process.env.REOTECH_NOTIFICATIONS_URL;
    delete process.env.REOTECH_NOTIFICATIONS_SERVICE_KEY;
    try {
      await expect(t.action(internal.notificationDelivery.dispatch, { outbox })).resolves.toEqual({ status: 'disabled' });
      await expect(owner.mutation(api.notificationDelivery.retryQueued, { workspace })).resolves.toEqual({ configured: false, count: 0, hasMore: false });
    } finally {
      if (url === undefined) delete process.env.REOTECH_NOTIFICATIONS_URL;
      else process.env.REOTECH_NOTIFICATIONS_URL = url;
      if (key === undefined) delete process.env.REOTECH_NOTIFICATIONS_SERVICE_KEY;
      else process.env.REOTECH_NOTIFICATIONS_SERVICE_KEY = key;
    }
    expect((await t.run(ctx => ctx.db.get(outbox)))?.status).toBe('pending');
  });

  test('records bounded exponential retries and stops after five attempts', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    const outbox = await t.run(async ctx => {
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient: 'member1',
        eventId: 'event1',
        type: 'update',
        title: 'Retry',
        body: 'Retry me.',
        readAt: null,
        createdAt: 1,
        dedupeKey: 'event1:member1',
      });
      return ctx.db.insert('notificationOutbox', {
        workspace,
        notification,
        idempotencyKey: 'event1:member1',
        status: 'pending',
        attempts: 1,
        nextAttemptAt: 0,
        createdAt: 1,
        updatedAt: 1,
        scheduleToken: 'attempt-token',
      });
    });
    const next = await t.mutation(internal.notificationDelivery.markFailed, { outbox, attempt: 1, token: 'attempt-token', error: 'upstream unavailable' });
    expect(next).toMatchObject({ token: expect.any(String), nextAttemptAt: expect.any(Number) });
    expect(await t.mutation(internal.notificationDelivery.markFailed, { outbox, attempt: 1, token: 'attempt-token', error: 'stale attempt' })).toBeNull();
    if (!next) throw new Error('Expected a retry token.');
    await t.run(async ctx => {
      await ctx.db.patch(outbox, { attempts: 5, status: 'pending', nextAttemptAt: 0, scheduleToken: next.token });
    });
    expect(await t.mutation(internal.notificationDelivery.markFailed, { outbox, attempt: 5, token: next.token, error: 'final failure' })).toBeNull();
    expect((await t.run(ctx => ctx.db.get(outbox)))?.status).toBe('failed');
  });

  test('invalidates a stale lease callback after a failed delivery schedules a retry', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    const snapshot = await owner.query(api.workspaces.snapshot, { workspace });
    const outbox = await t.run(async ctx => {
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient: snapshot.me,
        eventId: 'event-lease',
        type: 'update',
        title: 'Lease',
        body: 'Lease callback',
        readAt: null,
        createdAt: 1,
        dedupeKey: 'event-lease:owner',
      });
      return ctx.db.insert('notificationOutbox', {
        workspace,
        notification,
        idempotencyKey: 'event-lease:owner',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: 1,
        updatedAt: 1,
        scheduleToken: 'initial-token',
      });
    });
    const claimed = await t.mutation(internal.notificationDelivery.claim, { outbox, token: 'initial-token' });
    if (!claimed) throw new Error('Expected the notification to be claimed.');
    const retry = await t.mutation(internal.notificationDelivery.markFailed, {
      outbox,
      attempt: claimed.attempt,
      token: claimed.scheduleToken,
      error: 'network_error',
    });
    expect(retry).toMatchObject({ token: expect.any(String) });
    expect(await t.mutation(internal.notificationDelivery.claim, { outbox, token: claimed.scheduleToken })).toBeNull();
    expect(await t.mutation(internal.notificationDelivery.markSent, { outbox, attempt: claimed.attempt, token: claimed.scheduleToken })).toBe(false);
    expect((await t.run(ctx => ctx.db.get(outbox)))?.status).toBe('failed');
  });
});
