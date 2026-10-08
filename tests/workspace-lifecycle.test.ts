import { describe, expect, test, vi } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../convex/schema';
import { api, internal } from '../convex/_generated/api';

const modules = import.meta.glob('../convex/**/*.ts');
const auth = (name: string) => ({
  subject: name,
  issuer: 'https://test.clerk.accounts.dev',
  email: `${name}@example.com`,
  emailVerified: true,
  name,
});

describe('workspace lifecycle', () => {
  test('requires the owner and exact workspace name before marking deletion', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });

    await expect(owner.mutation(api.workspaces.deleteWorkspace, { workspace, name: 'team' })).rejects.toThrow('does not match');
    expect((await t.run(ctx => ctx.db.get(workspace)))?.lifecycle).toBeUndefined();
    await expect(t.withIdentity(auth('other')).mutation(api.workspaces.deleteWorkspace, { workspace, name: 'Team' })).rejects.toThrow('owner');

    await owner.mutation(api.workspaces.deleteWorkspace, { workspace, name: 'Team' });
    expect((await t.run(ctx => ctx.db.get(workspace)))?.lifecycle).toBe('deleting');
    await expect(owner.query(api.workspaces.snapshot, { workspace })).rejects.toThrow('no longer exists');
    expect(await owner.query(api.workspaces.list, {})).toEqual([]);
  });

  test('bounded cleanup removes workspace rows, notifications, links, and storage', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    const storage = await t.run(ctx => ctx.storage.store(new Blob(['workspace file'], { type: 'text/plain' })));
    await t.run(async ctx => {
      await ctx.db.insert('entities', { workspace, kind: 'files', key: 'file1', payload: JSON.stringify({ kind: 'files', value: { id: 'file1' } }) });
      await ctx.db.insert('uploads', { workspace, file: 'file1', storage, by: 'owner' });
      await ctx.db.insert('counters', { workspace, project: 'project1', next: 2 });
      await ctx.db.insert('pullRequestLinks', {
        workspace,
        project: 'project1',
        task: 'task1',
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        repository: 'repo',
        number: 1,
        url: 'https://github.com/acme/repo/pull/1',
        createdBy: 'owner',
        createdAt: 1,
      });
      await ctx.db.insert('notificationPreferences', {
        workspace,
        member: 'owner',
        mentions: true,
        assignments: true,
        comments: true,
        updates: true,
        email: false,
        push: true,
        updatedAt: 1,
      });
      await ctx.db.insert('notificationEvents', {
        workspace,
        actor: 'owner',
        actorName: 'Owner',
        before: null,
        after: JSON.stringify({ kind: 'update' }),
        cursor: null,
        createdAt: 1,
      });
      const notification = await ctx.db.insert('notifications', {
        workspace,
        recipient: 'owner',
        eventId: 'event1',
        type: 'update',
        title: 'Updated',
        body: 'Workspace update',
        readAt: null,
        createdAt: 1,
        dedupeKey: 'event1',
      });
      await ctx.db.insert('notificationOutbox', {
        workspace,
        notification,
        idempotencyKey: 'event1',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    vi.useFakeTimers();
    try {
      await owner.mutation(api.workspaces.deleteWorkspace, { workspace, name: 'Team' });
      await t.finishAllScheduledFunctions(() => vi.runOnlyPendingTimers());
    } finally {
      vi.useRealTimers();
    }

    expect(await t.run(ctx => ctx.db.get(workspace))).toBeNull();
    expect(await t.run(ctx => ctx.db.query('uploads').collect())).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.query('notifications').collect())).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.query('notificationEvents').collect())).toHaveLength(0);
    expect(await t.run(ctx => ctx.db.query('notificationOutbox').collect())).toHaveLength(0);
    expect(await t.run(ctx => ctx.storage.get(storage))).toBeNull();
  });

  test('cleanup is idempotent after the workspace has been removed', async () => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity(auth('owner'));
    const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
    await owner.mutation(api.workspaces.deleteWorkspace, { workspace, name: 'Team' });
    await t.finishInProgressScheduledFunctions();
    await expect(t.mutation(internal.workspaces.cleanup, { workspace })).resolves.toEqual({ status: 'done' });
  });
});
