import { describe, expect, test } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import { type Entity, type Project, type Task, memberSchema } from '../shared/model';
const modules = import.meta.glob('../convex/**/*.ts');
const auth = (name: string, verified = true) => ({
  subject: name,
  issuer: 'https://test.clerk.accounts.dev',
  email: `${name}@example.com`,
  emailVerified: verified,
  name,
});
const op = (before: Entity | null, after: Entity | null) => ({ before: before ? JSON.stringify(before) : null, after: after ? JSON.stringify(after) : null });
async function setup() {
  const t = convexTest(schema, modules),
    owner = t.withIdentity(auth('owner'));
  const workspace = await owner.mutation(api.workspaces.create, { name: 'Team' });
  const data = await owner.query(api.workspaces.snapshot, { workspace });
  const project: Project = {
    id: 'project1',
    key: 'PRJ',
    name: 'Project',
    icon: 'folder',
    color: 'indigo',
    status: 'planning',
    team: '',
    lead: data.me,
    due: null,
    start: null,
    fav: false,
    members: [data.me],
    desc: '',
    milestones: [],
    last: 0,
  };
  await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'projects', value: project })] });
  return { t, owner, workspace, project, data };
}
function task(project: string, id = 'task1'): Task {
  return {
    id,
    project,
    key: 'PRJ-201',
    title: 'Task',
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
  };
}
describe('workspace authorization and persistence', () => {
  test('rejects unauthenticated and unverified users; isolates workspaces', async () => {
    const { t, workspace } = await setup();
    await expect(t.query(api.workspaces.snapshot, { workspace })).rejects.toThrow();
    await expect(t.withIdentity(auth('outsider')).query(api.workspaces.snapshot, { workspace })).rejects.toThrow('access');
    await expect(t.withIdentity(auth('unverified', false)).mutation(api.workspaces.create, { name: 'X' })).rejects.toThrow('verified');
  });
  test('claims invitations by verified email and revokes access on removal', async () => {
    const { t, owner, workspace } = await setup();
    const invited = memberSchema.parse({
      id: 'member2',
      name: 'Teammate',
      email: 'teammate@example.com',
      role: 'Member',
      team: '',
      title: '',
      c: '#5A67D8',
      status: 'invited',
      last: null,
      tz: '',
    });
    await owner.mutation(api.members.update, { workspace, before: null, after: JSON.stringify(invited) });
    const teammate = t.withIdentity(auth('teammate'));
    await expect(teammate.query(api.workspaces.snapshot, { workspace })).rejects.toThrow('access');
    await teammate.mutation(api.workspaces.acceptInvitations, {});
    const snapshot = await teammate.query(api.workspaces.snapshot, { workspace });
    expect(snapshot.me).toBe('member2');
    await expect(teammate.mutation(api.members.update, { workspace, before: JSON.stringify(snapshot.members[0]), after: null })).rejects.toThrow();
    const profile = snapshot.members.find(m => m.id === invited.id)!;
    await owner.mutation(api.members.update, { workspace, before: JSON.stringify(profile), after: null });
    await expect(teammate.query(api.workspaces.snapshot, { workspace })).rejects.toThrow('access');
  });
  test('filters private project data and rejects unauthorized writes', async () => {
    const { t, owner, workspace, project } = await setup();
    const outsider = memberSchema.parse({
      id: 'm2',
      name: 'Other',
      email: 'other@example.com',
      role: 'Member',
      team: '',
      title: '',
      c: '#123456',
      status: 'invited',
      last: null,
      tz: '',
    });
    await owner.mutation(api.members.update, { workspace, before: null, after: JSON.stringify(outsider) });
    const other = t.withIdentity(auth('other'));
    await other.mutation(api.workspaces.acceptInvitations, {});
    const hidden = { ...project, access: 'private' as const };
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [op({ kind: 'projects', value: project }, { kind: 'projects', value: hidden }), op(null, { kind: 'tasks', value: task(project.id) })],
    });
    const snapshot = await other.query(api.workspaces.snapshot, { workspace });
    expect(snapshot.projects).toHaveLength(0);
    expect(snapshot.tasks).toHaveLength(0);
    await expect(other.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id, 'evil') })] })).rejects.toThrow(
      'access',
    );
    await expect(other.mutation(api.files.uploadUrl, { workspace, project: project.id })).rejects.toThrow('permission');
  });
  test('keeps independent edits and rejects stale edits atomically', async () => {
    const { owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [op(null, { kind: 'tasks', value: task(project.id) }), op(null, { kind: 'tasks', value: task(project.id, 'task2') })],
    });
    const initial = await owner.query(api.workspaces.snapshot, { workspace });
    expect(new Set(initial.tasks.map(t => t.key)).size).toBe(2);
    const first = initial.tasks[0],
      second = initial.tasks[1];
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [op({ kind: 'tasks', value: first }, { kind: 'tasks', value: { ...first, title: 'First edit' } })],
    });
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [op({ kind: 'tasks', value: second }, { kind: 'tasks', value: { ...second, title: 'Second edit' } })],
    });
    await expect(
      owner.mutation(api.entities.apply, {
        workspace,
        changes: [
          op({ kind: 'tasks', value: first }, { kind: 'tasks', value: { ...first, title: 'Stale edit' } }),
          op(null, { kind: 'tasks', value: task(project.id, 'third') }),
        ],
      }),
    ).rejects.toThrow('same item');
    const latest = await owner.query(api.workspaces.snapshot, { workspace });
    expect(latest.tasks.map(t => t.title).sort()).toEqual(['First edit', 'Second edit']);
  });
  test('cannot forge activity attribution or delete the owner', async () => {
    const { owner, workspace, project, data } = await setup();
    await expect(
      owner.mutation(api.entities.apply, {
        workspace,
        changes: [op(null, { kind: 'activity', value: { id: 'a1', by: 'someoneElse', verb: 'created', task: null, project: project.id, at: 1, extra: '' } })],
      }),
    ).rejects.toThrow('attributed');
    await expect(owner.mutation(api.members.update, { workspace, before: JSON.stringify(data.members[0]), after: null })).rejects.toThrow('owner');
  });
});

describe('shared files and identifiers', () => {
  test('uploads real bytes, derives attachments, and deletes storage with the task', async () => {
    const { t, owner, workspace, project, data } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });
    const storage = await t.run(ctx => ctx.storage.store(new Blob(['hello team'], { type: 'text/plain' })));
    const file = { id: 'file1', name: 'hello.txt', type: 'file', size: '1 KB', by: data.me, at: 1, project: project.id, task: 'task1' };
    await owner.mutation(api.files.finish, { workspace, storage, file: JSON.stringify(file) });
    const snapshot = await owner.query(api.workspaces.snapshot, { workspace });
    expect(snapshot.tasks[0].attachments[0].name).toBe('hello.txt');
    expect(await owner.query(api.files.download, { workspace, file: 'file1' })).toContain('http');
    await expect(t.withIdentity(auth('outsider')).query(api.files.download, { workspace, file: 'file1' })).rejects.toThrow('access');
    const saved = { ...snapshot.tasks[0], attachments: [] };
    await owner.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'tasks', value: saved }, null)] });
    expect((await owner.query(api.workspaces.snapshot, { workspace })).files).toHaveLength(0);
    expect(await t.run(ctx => ctx.storage.get(storage))).toBeNull();
  });
  test('does not reuse deleted task keys and removes dangling dependencies', async () => {
    const { owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [op(null, { kind: 'tasks', value: task(project.id) }), op(null, { kind: 'tasks', value: { ...task(project.id, 'task2'), deps: ['task1'] } })],
    });
    let snapshot = await owner.query(api.workspaces.snapshot, { workspace });
    const highest = snapshot.tasks.find(t => t.id === 'task2')!;
    await owner.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'tasks', value: highest }, null)] });
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: { ...task(project.id, 'task3'), deps: ['task1'] } })] });
    snapshot = await owner.query(api.workspaces.snapshot, { workspace });
    expect(snapshot.tasks.find(t => t.id === 'task3')?.key).toBe('PRJ-203');
    await owner.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'tasks', value: snapshot.tasks.find(t => t.id === 'task1')! }, null)] });
    expect((await owner.query(api.workspaces.snapshot, { workspace })).tasks[0].deps).toEqual([]);
  });
});
