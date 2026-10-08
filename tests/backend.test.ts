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
  test('prevents private project lockout through sharing changes or member removal', async () => {
    const { t, owner, workspace, project } = await setup();
    const invited = memberSchema.parse({
      id: 'solo',
      name: 'Solo',
      email: 'solo@example.com',
      role: 'Member',
      team: '',
      title: '',
      c: '#123456',
      status: 'invited',
      last: null,
      tz: '',
    });
    await owner.mutation(api.members.update, { workspace, before: null, after: JSON.stringify(invited) });
    const hidden: Project = { ...project, access: 'private', members: ['solo'], lead: 'solo' };
    await owner.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'projects', value: project }, { kind: 'projects', value: hidden })] });
    const solo = t.withIdentity(auth('solo'));
    await solo.mutation(api.workspaces.acceptInvitations, {});
    const snapshot = await solo.query(api.workspaces.snapshot, { workspace });
    const profile = snapshot.members.find(m => m.id === 'solo')!;
    await expect(owner.mutation(api.members.update, { workspace, before: JSON.stringify(profile), after: null })).rejects.toThrow('last manager');
    await expect(
      solo.mutation(api.entities.apply, {
        workspace,
        changes: [op({ kind: 'projects', value: hidden }, { kind: 'projects', value: { ...hidden, members: [] } })],
      }),
    ).rejects.toThrow('at least one');
    const ownerId = snapshot.members.find(m => m.role === 'Owner')!.id;
    const withViewer: Project = { ...hidden, members: ['solo', ownerId], perms: { [ownerId]: 'Can view' } };
    await solo.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'projects', value: hidden }, { kind: 'projects', value: withViewer })] });
    await expect(owner.mutation(api.members.update, { workspace, before: JSON.stringify(profile), after: null })).rejects.toThrow('last manager');
    await expect(
      solo.mutation(api.entities.apply, {
        workspace,
        changes: [op({ kind: 'projects', value: withViewer }, { kind: 'projects', value: { ...withViewer, lead: null } })],
      }),
    ).rejects.toThrow('last manager');
    expect((await solo.query(api.workspaces.snapshot, { workspace })).projects).toHaveLength(1);
  });
  test('rejects forged initial reactions and stamps comment time on the server', async () => {
    const { owner, workspace, project, data } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });
    const comment = { id: 'comment1', task: 'task1', by: data.me, at: 1, text: 'Hello', re: { like: ['someoneElse'] } };
    await expect(owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'comments', value: comment })] })).rejects.toThrow('own reactions');
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'comments', value: { ...comment, re: {} } })] });
    expect((await owner.query(api.workspaces.snapshot, { workspace })).comments[0].at).toBeGreaterThan(1);
  });
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

describe('pull request links', () => {
  test('deduplicates canonical GitHub URLs and removes the canonical link', async () => {
    const { owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });

    const first = await owner.mutation(api.pullRequestLinks.add, {
      workspace,
      task: 'task1',
      url: ' https://GitHub.com/Acme/Repo/pull/7/?tab=files#discussion ',
    });
    const second = await owner.mutation(api.pullRequestLinks.add, {
      workspace,
      task: 'task1',
      url: 'https://github.com/acme/repo/pull/7#overview',
    });
    const listed = await owner.query(api.pullRequestLinks.list, { workspace, task: 'task1' });

    expect(second).toBe(first);
    expect(listed.links).toHaveLength(1);
    expect(listed.links[0]).toMatchObject({
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repository: 'repo',
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
    });

    await owner.mutation(api.pullRequestLinks.remove, { workspace, task: 'task1', link: listed.links[0].id });
    expect((await owner.query(api.pullRequestLinks.list, { workspace, task: 'task1' })).links).toHaveLength(0);
  });

  test('keeps identical Forgejo references separate across hosts', async () => {
    const { owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });

    await owner.mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: 'https://git.one.test/Acme/Repo/pulls/8' });
    await owner.mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: 'https://git.two.test/acme/repo/pulls/8/' });
    const listed = await owner.query(api.pullRequestLinks.list, { workspace, task: 'task1' });

    expect(listed.links).toHaveLength(2);
    expect(new Set(listed.links.map(link => link.host))).toEqual(new Set(['git.one.test', 'git.two.test']));
    expect(listed.links.every(link => link.provider === 'forgejo')).toBe(true);
  });

  test('isolates workspaces, tasks, and link ids', async () => {
    const { t, owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [op(null, { kind: 'tasks', value: task(project.id) }), op(null, { kind: 'tasks', value: task(project.id, 'task2') })],
    });
    const linkId = await owner.mutation(api.pullRequestLinks.add, {
      workspace,
      task: 'task1',
      url: 'https://github.com/acme/repo/pull/11',
    });
    await expect(owner.mutation(api.pullRequestLinks.remove, { workspace, task: 'task2', link: linkId })).rejects.toThrow('unavailable');
    expect((await owner.query(api.pullRequestLinks.list, { workspace, task: 'task1' })).links).toHaveLength(1);

    const secondWorkspace = await owner.mutation(api.workspaces.create, { name: 'Other team' });
    const secondData = await owner.query(api.workspaces.snapshot, { workspace: secondWorkspace });
    const secondProject: Project = { ...project, id: 'other-project', key: 'OTHER', lead: secondData.me, members: [secondData.me] };
    await owner.mutation(api.entities.apply, { workspace: secondWorkspace, changes: [op(null, { kind: 'projects', value: secondProject })] });
    await owner.mutation(api.entities.apply, { workspace: secondWorkspace, changes: [op(null, { kind: 'tasks', value: task(secondProject.id) })] });
    const secondLinkId = await owner.mutation(api.pullRequestLinks.add, {
      workspace: secondWorkspace,
      task: 'task1',
      url: 'https://github.com/acme/other/pull/11',
    });
    await expect(owner.mutation(api.pullRequestLinks.remove, { workspace: secondWorkspace, task: 'task1', link: linkId })).rejects.toThrow('unavailable');
    await expect(owner.mutation(api.pullRequestLinks.remove, { workspace, task: 'task1', link: secondLinkId })).rejects.toThrow('unavailable');
    expect((await owner.query(api.pullRequestLinks.list, { workspace: secondWorkspace, task: 'task1' })).links).toHaveLength(1);
    const links = await t.run(ctx => ctx.db.query('pullRequestLinks').collect());
    expect(links.filter(link => link.workspace === workspace)).toHaveLength(1);
    expect(links.filter(link => link.workspace === secondWorkspace)).toHaveLength(1);
  });

  test('allows private project members to read but blocks Can view mutations, then revokes access', async () => {
    const { t, owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });
    const invited = memberSchema.parse({
      id: 'viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
      role: 'Member',
      team: '',
      title: '',
      c: '#123456',
      status: 'invited',
      last: null,
      tz: '',
    });
    await owner.mutation(api.members.update, { workspace, before: null, after: JSON.stringify(invited) });
    const viewer = t.withIdentity(auth('viewer'));
    await viewer.mutation(api.workspaces.acceptInvitations, {});
    const privateProject: Project = { ...project, access: 'private', members: [project.lead!, 'viewer'], perms: { viewer: 'Can view' } };
    await owner.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'projects', value: project }, { kind: 'projects', value: privateProject })] });
    const link = await owner.mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: 'https://github.com/acme/private/pull/12' });

    const visible = await viewer.query(api.pullRequestLinks.list, { workspace, task: 'task1' });
    expect(visible.canEdit).toBe(false);
    expect(visible.links).toHaveLength(1);
    await expect(viewer.mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: 'https://github.com/acme/private/pull/13' })).rejects.toThrow(
      'permission',
    );
    await expect(viewer.mutation(api.pullRequestLinks.remove, { workspace, task: 'task1', link })).rejects.toThrow('permission');

    const revokedProject: Project = { ...privateProject, members: [project.lead!], perms: {} };
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [op({ kind: 'projects', value: privateProject }, { kind: 'projects', value: revokedProject })],
    });
    await expect(viewer.query(api.pullRequestLinks.list, { workspace, task: 'task1' })).rejects.toThrow('unavailable');
  });

  test('rejects unauthenticated and outsider access', async () => {
    const { t, owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });
    await expect(t.query(api.pullRequestLinks.list, { workspace, task: 'task1' })).rejects.toThrow();
    await expect(t.withIdentity(auth('outsider')).query(api.pullRequestLinks.list, { workspace, task: 'task1' })).rejects.toThrow('access');
    await expect(
      t.withIdentity(auth('outsider')).mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: 'https://github.com/a/b/pull/1' }),
    ).rejects.toThrow('access');
  });

  test('deleting a task or project removes its link rows', async () => {
    const { t, owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });
    await owner.mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: 'https://github.com/acme/repo/pull/21' });
    const current = (await owner.query(api.workspaces.snapshot, { workspace })).tasks[0];
    await owner.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'tasks', value: current }, null)] });
    expect(await owner.query(api.workspaces.snapshot, { workspace })).toMatchObject({ tasks: [] });
    expect(await t.run(ctx => ctx.db.query('pullRequestLinks').collect())).toHaveLength(0);

    const secondProject: Project = { ...project, id: 'project2', key: 'SEC', name: 'Second project' };
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'projects', value: secondProject })] });
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(secondProject.id, 'task2') })] });
    await owner.mutation(api.pullRequestLinks.add, { workspace, task: 'task2', url: 'https://github.com/acme/repo/pull/22' });
    await owner.mutation(api.entities.apply, { workspace, changes: [op({ kind: 'projects', value: secondProject }, null)] });
    expect(await t.run(ctx => ctx.db.query('pullRequestLinks').collect())).toHaveLength(0);
  });

  test('enforces the fifty-link task bound', async () => {
    const { owner, workspace, project } = await setup();
    await owner.mutation(api.entities.apply, { workspace, changes: [op(null, { kind: 'tasks', value: task(project.id) })] });
    for (let number = 1; number <= 50; number += 1) {
      await owner.mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: `https://github.com/acme/repo/pull/${number}` });
    }
    await expect(owner.mutation(api.pullRequestLinks.add, { workspace, task: 'task1', url: 'https://github.com/acme/repo/pull/51' })).rejects.toThrow(
      'at most 50',
    );
    expect((await owner.query(api.pullRequestLinks.list, { workspace, task: 'task1' })).links).toHaveLength(50);
  });
});
