import { describe, expect, test } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../convex/schema';
import { api, internal } from '../convex/_generated/api';
import { put } from '../convex/access';
import type { Entity, Project, Task } from '../shared/model';
import { memberSchema } from '../shared/model';
import { agentContextRequestSchema, agentGetResponseSchema, agentSearchRequestSchema, agentSearchResponseSchema } from '../shared/agent';

const modules = import.meta.glob('../convex/**/*.ts');
const auth = (name: string, verified = true) => ({
  subject: `subject-${name}-sensitive`,
  issuer: 'https://test.clerk.accounts.dev',
  email: `${name}@example.com`,
  emailVerified: verified,
  name,
});
function project(id: string, member: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    key: id.toUpperCase().replaceAll('_', '-'),
    name: id,
    icon: 'folder',
    color: 'indigo',
    status: 'planning',
    team: '',
    lead: member,
    due: null,
    start: null,
    fav: false,
    members: [member],
    desc: '',
    milestones: [],
    last: 0,
    ...overrides,
  };
}
function task(id: string, project: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    project,
    key: `${project.toUpperCase()}-${id}`,
    title: `Task ${id}`,
    status: 'todo',
    assignee: null,
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
    ...overrides,
  };
}
const operation = (before: Entity | null, after: Entity | null) => ({ before: before && JSON.stringify(before), after: after && JSON.stringify(after) });
async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(auth('owner'));
  const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
  const data = await owner.query(api.workspaces.snapshot, { workspace });
  const p = project('p1', data.me);
  await t.run(ctx => put(ctx, workspace, { kind: 'projects', value: p }));
  return { t, owner, workspace, p, me: data.me };
}
type Harness = Awaited<ReturnType<typeof setup>>['t'];
async function ready(t: Harness, limit = 20) {
  let state: { status: 'running' | 'ready'; cursor: string | null; processed: number } = await t.mutation(internal.agentIndex.start, {});
  for (let batch = 0; state.status !== 'ready' && batch < 100; batch++) state = await t.mutation(internal.agentIndex.backfill, { cursor: state.cursor, limit });
  expect(state.status).toBe('ready');
  return state;
}
async function invite(h: Awaited<ReturnType<typeof setup>>, name: string, role: 'Guest' | 'Member' = 'Member') {
  const profile = memberSchema.parse({
    id: name,
    name,
    email: `${name}@example.com`,
    role,
    team: '',
    title: '',
    c: '#123456',
    status: 'invited',
    last: null,
    tz: '',
  });
  await h.owner.mutation(api.members.update, { workspace: h.workspace, before: null, after: JSON.stringify(profile) });
  const user = h.t.withIdentity(auth(name));
  await user.mutation(api.workspaces.acceptInvitations, {});
  return user;
}

describe('agent authorization and selection', () => {
  test('requires verified auth and rejects supplied principals and implicit workspace', async () => {
    const h = await setup();
    const args = { workspace: h.workspace, project: h.p.id };
    for (const client of [h.t, h.t.withIdentity(auth('owner', false))]) {
      await expect(client.query(api.agent.context, {})).rejects.toThrow('verified');
      await expect(client.query(api.agent.search, args)).rejects.toThrow('verified');
      await expect(client.query(api.agent.get, { ...args, task: { id: 't1' } })).rejects.toThrow('verified');
    }
    await expect(h.owner.query(api.agent.context, { project: h.p.id })).rejects.toThrow('explicit workspace');
    expect(agentContextRequestSchema.safeParse({ principal: 'owner' }).success).toBe(false);
    expect(agentSearchRequestSchema.safeParse({ ...args, identity: 'owner' }).success).toBe(false);
    await expect(h.t.withIdentity({ ...auth('different'), email: 'owner@example.com' }).query(api.agent.context, args)).rejects.toThrow('access');
    const result = await h.owner.query(api.agent.context, args);
    expect(result).toEqual({
      kind: 'selection',
      selection: { workspace: { id: h.workspace, name: 'Team' }, project: { id: 'p1', key: 'P1', name: 'p1' }, member: { id: h.me, role: 'Owner' } },
    });
    await expect(h.owner.query(api.agent.context, { ...args, project: 'missing' })).rejects.toThrow('Project is unavailable');
  });
  test('bounds workspace enumeration, binds cursor, and isolates identical keys', async () => {
    const h = await setup();
    const otherWorkspace = await h.owner.mutation(api.workspaces.create, { name: 'Second' });
    await h.t.run(async ctx => {
      await put(ctx, otherWorkspace, { kind: 'projects', value: h.p });
      await put(ctx, h.workspace, { kind: 'tasks', value: task('one', h.p.id, { key: 'P1-201', title: 'First workspace' }) });
      await put(ctx, otherWorkspace, { kind: 'tasks', value: task('one', h.p.id, { key: 'P1-201', title: 'Second workspace' }) });
    });
    await ready(h.t);
    const first = await h.owner.query(api.agent.context, { limit: 1 });
    expect(first.kind).toBe('workspaces');
    if (first.kind !== 'workspaces') throw new Error('Expected workspaces');
    expect(first.workspaces).toHaveLength(1);
    expect(first.page.isDone).toBe(false);
    expect(JSON.stringify(first)).not.toContain(auth('owner').issuer);
    expect(JSON.stringify(first)).not.toContain(auth('owner').subject);
    expect(JSON.parse(first.page.cursor ?? '{}')).toMatchObject({ scope: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const second = await h.owner.query(api.agent.context, { limit: 1, cursor: first.page.cursor ?? undefined });
    if (second.kind !== 'workspaces') throw new Error('Expected workspaces');
    expect(second.workspaces[0].id).not.toBe(first.workspaces[0].id);
    await expect(h.owner.query(api.agent.context, { workspace: h.workspace, cursor: first.page.cursor ?? undefined })).rejects.toThrow('AGENT_CURSOR_INVALID');
    for (const [workspace, title] of [
      [h.workspace, 'First workspace'],
      [otherWorkspace, 'Second workspace'],
    ] as const) {
      expect((await h.owner.query(api.agent.get, { workspace, project: 'p1', task: { key: 'P1-201' } })).task.title).toBe(title);
    }
    const outsider = h.t.withIdentity(auth('outsider'));
    await expect(outsider.query(api.agent.get, { workspace: h.workspace, project: 'p1', task: { key: 'P1-201' } })).rejects.toThrow('access');
  });
  test('keeps sparse project scans bounded and resumes without skipping authorized projects', async () => {
    const h = await setup();
    const guest = await invite(h, 'guest', 'Guest');
    await h.t.run(async ctx => {
      for (let i = 0; i < 102; i++)
        await put(ctx, h.workspace, { kind: 'projects', value: project(`hidden${i.toString().padStart(3, '0')}`, h.me, { private: true }) });
      const visible = project('z_visible', h.me, { members: [h.me, 'guest'] });
      // Legacy projects remain discoverable even before the task index backfill.
      await ctx.db.insert('entities', {
        workspace: h.workspace,
        kind: 'projects',
        key: visible.id,
        payload: JSON.stringify({ kind: 'projects', value: visible }),
      });
    });
    const first = await guest.query(api.agent.context, { workspace: h.workspace, limit: 1 });
    if (first.kind !== 'projects') throw new Error('Expected projects');
    expect(first.projects).toEqual([]);
    expect(first.page.isDone).toBe(false);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(auth('guest').issuer);
    expect(serialized).not.toContain(auth('guest').subject);
    for (let i = 0; i < 102; i++) expect(serialized).not.toContain(`hidden${i.toString().padStart(3, '0')}`);
    expect(JSON.parse(first.page.cursor ?? '{}')).toMatchObject({ scope: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(h.owner.query(api.agent.context, { workspace: h.workspace, cursor: first.page.cursor ?? undefined })).rejects.toThrow('AGENT_CURSOR_INVALID');
    const next = await guest.query(api.agent.context, { workspace: h.workspace, limit: 1, cursor: first.page.cursor ?? undefined });
    if (next.kind !== 'projects') throw new Error('Expected projects');
    expect(next.projects.map(p => p.id)).toEqual(['z_visible']);
    expect(next.page.isDone).toBe(true);
    await expect(guest.query(api.agent.context, { workspace: h.workspace, limit: 51 })).rejects.toThrow();
  });
  test('filters private and Guest projects before pagination and denies fresh calls after revocation', async () => {
    const h = await setup();
    const member = await invite(h, 'viewer');
    const guest = await invite(h, 'guest', 'Guest');
    await h.t.run(async ctx => {
      await put(ctx, h.workspace, { kind: 'projects', value: project('a_hidden', h.me, { access: 'private' }) });
      await put(ctx, h.workspace, { kind: 'projects', value: project('b_visible', h.me, { members: [h.me, 'guest'] }) });
      await put(ctx, h.workspace, { kind: 'projects', value: project('z_hidden', h.me, { access: 'private' }) });
      await put(ctx, h.workspace, { kind: 'tasks', value: task('one', 'b_visible') });
    });
    await ready(h.t);
    const first = await guest.query(api.agent.context, { workspace: h.workspace, limit: 1 });
    if (first.kind !== 'projects') throw new Error('Expected projects');
    expect(first.projects.map(p => p.id)).toEqual(['b_visible']);
    expect(first.page).toEqual({ cursor: null, isDone: true });
    const visible = await member.query(api.agent.context, { workspace: h.workspace });
    if (visible.kind !== 'projects') throw new Error('Expected projects');
    expect(visible.projects.map(p => p.id)).toEqual(['b_visible', 'p1']);
    for (const user of [member, guest])
      await expect(user.query(api.agent.search, { workspace: h.workspace, project: 'a_hidden' })).rejects.toThrow('Project is unavailable');
    await guest.query(api.agent.get, { workspace: h.workspace, project: 'b_visible', task: { id: 'one' } });
    await h.t.run(ctx => put(ctx, h.workspace, { kind: 'projects', value: project('b_visible', h.me) }));
    await expect(guest.query(api.agent.get, { workspace: h.workspace, project: 'b_visible', task: { id: 'one' } })).rejects.toThrow('Project is unavailable');
    const snapshot = await member.query(api.workspaces.snapshot, { workspace: h.workspace });
    const profile = snapshot.members.find(m => m.id === 'viewer');
    if (!profile) throw new Error('Missing viewer');
    await h.owner.mutation(api.members.update, { workspace: h.workspace, before: JSON.stringify(profile), after: null });
    await expect(member.query(api.agent.context, { workspace: h.workspace })).rejects.toThrow('access');
    await expect(member.query(api.agent.search, { workspace: h.workspace, project: 'p1' })).rejects.toThrow('access');
    await expect(member.query(api.agent.get, { workspace: h.workspace, project: 'p1', task: { id: 'one' } })).rejects.toThrow('access');
  });
});

describe('agent task reads', () => {
  test('paginates concise summaries with title, status and nullable assignee filters and rejects cursor reuse', async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      for (let i = 0; i < 7; i++)
        await put(ctx, h.workspace, {
          kind: 'tasks',
          value: task(`t${i}`, 'p1', {
            title: i < 5 ? `Release ${i}` : 'Other',
            status: i % 2 ? 'done' : 'todo',
            assignee: i < 3 ? null : h.me,
            desc: 'must not leak',
          }),
        });
    });
    const secondWorkspace = await h.owner.mutation(api.workspaces.create, { name: 'Second' });
    await h.t.run(async ctx => {
      await put(ctx, secondWorkspace, { kind: 'projects', value: h.p });
      await put(ctx, h.workspace, { kind: 'projects', value: project('p2', h.me) });
    });
    await ready(h.t);
    const args = { workspace: h.workspace, project: 'p1', limit: 2 };
    const first = await h.owner.query(api.agent.search, args);
    expect(first.tasks).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain(auth('owner').issuer);
    expect(JSON.stringify(first)).not.toContain(auth('owner').subject);
    expect(JSON.parse(first.page.cursor ?? '{}')).toMatchObject({ scope: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(agentSearchResponseSchema.safeParse(first).success).toBe(true);
    expect(first.tasks[0]).not.toHaveProperty('desc');
    expect(first.tasks[0]).not.toHaveProperty('attachments');
    const ids = first.tasks.map(t => t.id);
    let page = first.page;
    for (let i = 0; !page.isDone && i < 10; i++) {
      const next = await h.owner.query(api.agent.search, { ...args, cursor: page.cursor ?? undefined });
      expect(next.tasks.length).toBeLessThanOrEqual(2);
      ids.push(...next.tasks.map(t => t.id));
      page = next.page;
    }
    expect(page.isDone).toBe(true);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toHaveLength(7);
    for (const changed of [{ status: 'done' as const }, { assignee: null }, { query: 'Release' }]) {
      await expect(h.owner.query(api.agent.search, { ...args, ...changed, cursor: first.page.cursor ?? undefined })).rejects.toThrow('AGENT_CURSOR_INVALID');
    }
    for (const selection of [{ workspace: secondWorkspace }, { project: 'p2' }]) {
      await expect(h.owner.query(api.agent.search, { ...args, ...selection, cursor: first.page.cursor ?? undefined })).rejects.toThrow('AGENT_CURSOR_INVALID');
    }
    const filtered = await h.owner.query(api.agent.search, { ...args, limit: 50, query: 'Release', status: 'todo', assignee: null });
    expect(filtered.tasks.map(t => t.id).sort()).toEqual(['t0', 't2']);
    expect((await h.owner.query(api.agent.search, { ...args, limit: 50, assignee: null })).tasks).toHaveLength(3);
    expect((await h.owner.query(api.agent.search, { ...args, limit: 50, status: 'done', assignee: h.me })).tasks).toHaveLength(2);
    await expect(h.owner.query(api.agent.search, { ...args, limit: 51 })).rejects.toThrow();
    await expect(h.owner.query(api.agent.search, { ...args, cursor: 'broken' })).rejects.toThrow('AGENT_CURSOR_INVALID');
    await expect(h.owner.query(api.agent.search, { ...args, query: 'x'.repeat(201) })).rejects.toThrow();
  });
  test('scopes get to the selected project and bounds requested description and PR references', async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      await put(ctx, h.workspace, { kind: 'projects', value: project('p2', h.me) });
      await put(ctx, h.workspace, { kind: 'tasks', value: task('one', 'p1', { key: 'SAME', desc: 'x'.repeat(10001) }) });
      await put(ctx, h.workspace, { kind: 'tasks', value: task('two', 'p2', { key: 'SAME' }) });
      for (let i = 0; i < 51; i++)
        await ctx.db.insert('pullRequestLinks', {
          workspace: h.workspace,
          project: 'p1',
          task: 'one',
          provider: 'github',
          host: 'github.com',
          owner: 'owner',
          repository: 'repo',
          number: i + 1,
          url: `https://github.com/owner/repo/pull/${i + 1}`,
          createdBy: h.me,
          createdAt: 1,
        });
    });
    await ready(h.t);
    const args = { workspace: h.workspace, project: 'p1', task: { id: 'one' } };
    const minimal = await h.owner.query(api.agent.get, args);
    expect(agentGetResponseSchema.safeParse(minimal).success).toBe(true);
    expect(minimal).not.toHaveProperty('description');
    expect(minimal.pullRequests).toHaveLength(50);
    const full = await h.owner.query(api.agent.get, { ...args, includeDescription: true });
    expect(full.description).toHaveLength(10000);
    expect(full.descriptionTruncated).toBe(true);
    expect((await h.owner.query(api.agent.get, { ...args, task: { key: 'SAME' } })).task.id).toBe('one');
    expect((await h.owner.query(api.agent.get, { ...args, project: 'p2', task: { key: 'SAME' } })).task.id).toBe('two');
    await expect(h.owner.query(api.agent.get, { ...args, project: 'p2' })).rejects.toThrow('Task is unavailable');
  });
});

describe('internal agent index migration', () => {
  test('recovers the durable checkpoint after an interrupted operator loses a batch response', async () => {
    const h = await setup();
    expect(await h.t.query(internal.agentIndex.status, {})).toEqual({ status: 'not_started', cursor: null, processed: 0 });
    await h.t.run(async ctx => {
      for (let i = 0; i < 4; i++) {
        const value = task(`old${i}`, 'p1');
        await ctx.db.insert('entities', { workspace: h.workspace, kind: 'tasks', key: value.id, payload: JSON.stringify({ kind: 'tasks', value }) });
      }
    });
    await h.t.mutation(internal.agentIndex.start, {});
    // Simulate an operator disconnect after the transaction commits: discard its response.
    await h.t.mutation(internal.agentIndex.backfill, { cursor: null, limit: 2 });
    let state = await h.t.query(internal.agentIndex.status, {});
    expect(state).toMatchObject({ status: 'running', processed: 2 });
    expect(state.cursor).not.toBeNull();
    await expect(h.t.mutation(internal.agentIndex.backfill, { cursor: null, limit: 2 })).rejects.toThrow('STALE_CURSOR');
    for (let i = 0; state.status === 'running' && i < 10; i++) state = await h.t.mutation(internal.agentIndex.backfill, { cursor: state.cursor, limit: 2 });
    expect(await h.t.query(internal.agentIndex.status, {})).toEqual({ status: 'ready', cursor: null, processed: 5 });
    expect((await h.owner.query(api.agent.search, { workspace: h.workspace, project: 'p1' })).tasks).toHaveLength(4);
  });
  test('serializes competing starts and batches without advancing twice', async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      for (let i = 0; i < 3; i++) await put(ctx, h.workspace, { kind: 'tasks', value: task(`t${i}`, 'p1') });
    });
    const starts = await Promise.allSettled([h.t.mutation(internal.agentIndex.start, {}), h.t.mutation(internal.agentIndex.start, {})]);
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const batches = await Promise.allSettled([
      h.t.mutation(internal.agentIndex.backfill, { cursor: null, limit: 1 }),
      h.t.mutation(internal.agentIndex.backfill, { cursor: null, limit: 1 }),
    ]);
    expect(batches.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await h.t.run(ctx => ctx.db.query('agentIndexState').unique())).toMatchObject({ status: 'running', processed: 1 });
  });
  test('legacy rows fail closed until bounded backfill finishes and stale batches/restarts are rejected', async () => {
    const h = await setup();
    await h.t.run(async ctx => {
      for (let i = 0; i < 6; i++) {
        const value = task(`old${i}`, 'p1');
        await ctx.db.insert('entities', { workspace: h.workspace, kind: 'tasks', key: value.id, payload: JSON.stringify({ kind: 'tasks', value }) });
      }
    });
    const args = { workspace: h.workspace, project: 'p1' };
    await expect(h.owner.query(api.agent.search, args)).rejects.toThrow('AGENT_INDEX_NOT_READY');
    await expect(h.owner.query(api.agent.get, { ...args, task: { id: 'old0' } })).rejects.toThrow('AGENT_INDEX_NOT_READY');
    await h.t.mutation(internal.agentIndex.start, {});
    await expect(h.t.mutation(internal.agentIndex.start, {})).rejects.toThrow('ALREADY_STARTED');
    let state = await h.t.mutation(internal.agentIndex.backfill, { cursor: null, limit: 2 });
    expect(state.status).toBe('running');
    expect(state.processed).toBe(2);
    await expect(h.owner.query(api.agent.search, args)).rejects.toThrow('AGENT_INDEX_NOT_READY');
    await expect(h.t.mutation(internal.agentIndex.backfill, { cursor: null, limit: 2 })).rejects.toThrow('STALE_CURSOR');
    await expect(h.t.mutation(internal.agentIndex.backfill, { cursor: state.cursor, limit: 26 })).rejects.toThrow('limit');
    for (let i = 0; state.status === 'running' && i < 10; i++) state = await h.t.mutation(internal.agentIndex.backfill, { cursor: state.cursor, limit: 2 });
    expect(state).toMatchObject({ status: 'ready', processed: 7 });
    expect((await h.owner.query(api.agent.search, args)).tasks).toHaveLength(6);
    expect((await h.owner.query(api.agent.get, { ...args, task: { key: 'P1-old0' } })).task.id).toBe('old0');
    await expect(h.t.mutation(internal.agentIndex.start, {})).rejects.toThrow('ALREADY_STARTED');
  });
  test('validates legacy payloads atomically and resumes after repair', async () => {
    const h = await setup();
    const row = await h.t.run(ctx =>
      ctx.db.insert('entities', { workspace: h.workspace, kind: 'tasks', key: 'bad', payload: JSON.stringify({ kind: 'tasks', value: task('forged', 'p1') }) }),
    );
    await h.t.mutation(internal.agentIndex.start, {});
    await expect(h.t.mutation(internal.agentIndex.backfill, { cursor: null })).rejects.toThrow('INVALID_ENTITY');
    expect(await h.t.run(ctx => ctx.db.query('agentIndexState').unique())).toMatchObject({ status: 'running', cursor: null, processed: 0 });
    await h.t.run(ctx => ctx.db.patch(row, { payload: JSON.stringify({ kind: 'tasks', value: { ...task('bad', 'p1'), status: 'malicious' } }) }));
    await expect(h.t.mutation(internal.agentIndex.backfill, { cursor: null })).rejects.toThrow();
    await h.t.run(ctx => ctx.db.patch(row, { payload: JSON.stringify({ kind: 'tasks', value: task('bad', 'p1') }) }));
    expect((await h.t.mutation(internal.agentIndex.backfill, { cursor: null })).status).toBe('ready');
  });
  test('writes during migration and subsequent edits/deletes keep indexes consistent', async () => {
    const h = await setup();
    const old = task('legacy', 'p1');
    const oldRow = await h.t.run(ctx =>
      ctx.db.insert('entities', { workspace: h.workspace, kind: 'tasks', key: old.id, payload: JSON.stringify({ kind: 'tasks', value: old }) }),
    );
    const removedRow = await h.t.run(ctx =>
      ctx.db.insert('entities', {
        workspace: h.workspace,
        kind: 'tasks',
        key: 'removed',
        payload: JSON.stringify({ kind: 'tasks', value: task('removed', 'p1') }),
      }),
    );
    await h.t.mutation(internal.agentIndex.start, {});
    let state = await h.t.mutation(internal.agentIndex.backfill, { cursor: null, limit: 1 });
    await h.t.run(async ctx => {
      await ctx.db.delete(removedRow);
      await put(ctx, h.workspace, { kind: 'tasks', value: { ...old, title: 'Current release', status: 'done' } });
      await put(ctx, h.workspace, { kind: 'tasks', value: task('new', 'p1') });
    });
    for (let i = 0; state.status === 'running' && i < 10; i++) state = await h.t.mutation(internal.agentIndex.backfill, { cursor: state.cursor, limit: 1 });
    expect(state.status).toBe('ready');
    await expect(h.owner.query(api.agent.get, { workspace: h.workspace, project: 'p1', task: { id: 'removed' } })).rejects.toThrow('Task is unavailable');
    expect((await h.owner.query(api.agent.search, { workspace: h.workspace, project: 'p1', query: 'Current', status: 'done' })).tasks[0].id).toBe('legacy');
    await h.t.run(ctx => ctx.db.delete(oldRow));
    await expect(h.owner.query(api.agent.get, { workspace: h.workspace, project: 'p1', task: { key: old.key } })).rejects.toThrow('Task is unavailable');
    const fresh = task('public', 'p1');
    await h.owner.mutation(api.entities.apply, { workspace: h.workspace, changes: [operation(null, { kind: 'tasks', value: fresh })] });
    let snapshot = await h.owner.query(api.workspaces.snapshot, { workspace: h.workspace });
    const persisted = snapshot.tasks.find(t => t.id === fresh.id);
    if (!persisted) throw new Error('Missing persisted task');
    const edited = { ...persisted, title: 'Indexed edit', status: 'review' as const, assignee: h.me };
    await h.owner.mutation(api.entities.apply, {
      workspace: h.workspace,
      changes: [operation({ kind: 'tasks', value: persisted }, { kind: 'tasks', value: edited })],
    });
    expect(
      (await h.owner.query(api.agent.search, { workspace: h.workspace, project: 'p1', query: 'Indexed', status: 'review', assignee: h.me })).tasks.map(
        t => t.id,
      ),
    ).toEqual(['public']);
    expect((await h.owner.query(api.agent.get, { workspace: h.workspace, project: 'p1', task: { key: persisted.key } })).task.title).toBe('Indexed edit');
    snapshot = await h.owner.query(api.workspaces.snapshot, { workspace: h.workspace });
    const updated = snapshot.tasks.find(t => t.id === fresh.id);
    if (!updated) throw new Error('Missing updated task');
    await h.owner.mutation(api.entities.apply, { workspace: h.workspace, changes: [operation({ kind: 'tasks', value: updated }, null)] });
    expect((await h.owner.query(api.agent.search, { workspace: h.workspace, project: 'p1', query: 'Indexed' })).tasks).toEqual([]);
  });
});
