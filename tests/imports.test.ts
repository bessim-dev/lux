import { describe, expect, test } from 'vitest';
import { convexTest } from 'convex-test';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import { importEntitySchema, type ImportBatch } from '../shared/imports';
import { memberSchema, type Entity } from '../shared/model';
import { repositoryUrlSchema } from '../shared/repository';
const modules = import.meta.glob('../convex/**/*.ts');
const auth = (name: string) => ({ subject: name, issuer: 'https://test.clerk.accounts.dev', email: `${name}@example.com`, emailVerified: true, name });
const batch = (records: ImportBatch['records'], provider: ImportBatch['provider'] = 'plane') =>
  JSON.stringify({ provider, namespace: 'source/workspace', records });
const record = (entity: Entity) => ({ sourceId: entity.value.id, entity: importEntitySchema.parse(entity), raw: '{"historical":true}' });
async function setup() {
  const t = convexTest(schema, modules),
    owner = t.withIdentity(auth('owner'));
  const workspace = await owner.mutation(api.workspaces.create, { name: 'Imports' });
  const data = await owner.query(api.workspaces.snapshot, { workspace });
  const project = record({
    kind: 'projects',
    value: {
      id: 'p1',
      key: 'LUX',
      name: 'Lux',
      icon: 'folder',
      color: 'indigo',
      status: 'active',
      team: '',
      lead: data.me,
      due: null,
      start: null,
      fav: false,
      members: [data.me],
      desc: '',
      milestones: [],
      last: 0,
    },
  });
  const task = record({
    kind: 'tasks',
    value: {
      id: 't1',
      project: 'p1',
      key: 'LUX-37',
      title: 'Imported',
      status: 'todo',
      assignee: data.me,
      priority: 'none',
      due: null,
      start: null,
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: 'History',
      estimate: null,
      created: 123,
      updated: 456,
      order: 1,
      fav: false,
      recur: null,
    },
  });
  return { t, owner, workspace, data, project, task };
}
describe('repeatable imports', () => {
  test('preserves source keys/times and provenance, retries without duplicates, and seeds native counters', async () => {
    const { t, owner, workspace, project, task } = await setup();
    const input = { workspace, batch: batch([project, task]) };
    expect((await owner.mutation(api.imports.apply, input)).map(r => r.status)).toEqual(['created', 'created']);
    expect((await owner.mutation(api.imports.apply, input)).map(r => r.status)).toEqual(['unchanged', 'unchanged']);
    let data = await owner.query(api.workspaces.snapshot, { workspace });
    expect(data.tasks[0]).toMatchObject({ key: 'LUX-37', created: 123, updated: 456 });
    expect(await t.run(ctx => ctx.db.query('importRecords').collect())).toHaveLength(2);
    expect(await t.run(ctx => ctx.db.query('importRecords').first())).toMatchObject({ raw: '{"historical":true}' });
    const native = { ...data.tasks[0]!, id: 'native', key: 'anything' };
    await owner.mutation(api.entities.apply, { workspace, changes: [{ before: null, after: JSON.stringify({ kind: 'tasks', value: native }) }] });
    data = await owner.query(api.workspaces.snapshot, { workspace });
    expect(data.tasks.find(t => t.id === 'native')?.key).toBe('LUX-38');
  });
  test('pulls source updates only while destination is unchanged; preserves local edits and deleted records', async () => {
    const { t, owner, workspace, project, task } = await setup();
    await owner.mutation(api.imports.apply, { workspace, batch: batch([project, task]) });
    if (task.entity.kind !== 'tasks') throw new Error('fixture');
    task.entity.value.title = 'Source update';
    expect((await owner.mutation(api.imports.apply, { workspace, batch: batch([task]) }))[0]?.status).toBe('updated');
    const current = (await owner.query(api.workspaces.snapshot, { workspace })).tasks[0]!;
    await owner.mutation(api.entities.apply, {
      workspace,
      changes: [
        { before: JSON.stringify({ kind: 'tasks', value: current }), after: JSON.stringify({ kind: 'tasks', value: { ...current, title: 'Local edit' } }) },
      ],
    });
    expect((await owner.mutation(api.imports.apply, { workspace, batch: batch([task]) }))[0]?.status).toBe('conflict');
    expect((await owner.query(api.workspaces.snapshot, { workspace })).tasks[0]?.title).toBe('Local edit');
    await t.run(async ctx => {
      const row = await ctx.db
        .query('entities')
        .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', 'tasks').eq('key', 't1'))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });
    expect((await owner.mutation(api.imports.apply, { workspace, batch: batch([task]) }))[0]?.status).toBe('conflict');
  });
  test('denies anonymous, outsider, and invited member import writes', async () => {
    const { t, owner, workspace, project } = await setup();
    const input = { workspace, batch: batch([project]) };
    await expect(t.mutation(api.imports.apply, input)).rejects.toThrow();
    await expect(t.withIdentity(auth('outsider')).mutation(api.imports.apply, input)).rejects.toThrow('access');
    const member = memberSchema.parse({
      id: 'member',
      name: 'Member',
      email: 'member@example.com',
      role: 'Admin',
      team: '',
      title: '',
      c: '#123456',
      status: 'invited',
      last: null,
      tz: '',
    });
    await owner.mutation(api.members.update, { workspace, before: null, after: JSON.stringify(member) });
    const admin = t.withIdentity(auth('member'));
    await admin.mutation(api.workspaces.acceptInvitations, {});
    await expect(admin.mutation(api.imports.apply, input)).rejects.toThrow('owner');
  });
  test('rejects key collisions, source rebinding, unknown foreign keys, and duplicate project keys atomically', async () => {
    const { owner, workspace, project, task } = await setup();
    await owner.mutation(api.imports.apply, { workspace, batch: batch([project, task]) });
    if (task.entity.kind !== 'tasks' || project.entity.kind !== 'projects') throw new Error('fixture');
    const collision = structuredClone(task);
    collision.sourceId = 'second';
    collision.entity.value.id = 'second';
    await expect(owner.mutation(api.imports.apply, { workspace, batch: batch([collision]) })).rejects.toThrow('Task key');
    const rebound = structuredClone(task);
    rebound.entity.value.id = 'rebound';
    await expect(owner.mutation(api.imports.apply, { workspace, batch: batch([rebound]) })).rejects.toThrow('rebound');
    const foreign = structuredClone(task);
    foreign.sourceId = 'foreign';
    foreign.entity.value.id = 'foreign';
    if (foreign.entity.kind !== 'tasks') throw new Error('fixture');
    foreign.entity.value.project = 'missing';
    await expect(owner.mutation(api.imports.apply, { workspace, batch: batch([foreign]) })).rejects.toThrow('project');
    const duplicate = structuredClone(project);
    duplicate.sourceId = 'p2';
    duplicate.entity.value.id = 'p2';
    await expect(owner.mutation(api.imports.apply, { workspace, batch: batch([duplicate]) })).rejects.toThrow('Project key');
    await expect(owner.mutation(api.imports.apply, { workspace, batch: batch([project, project]) })).rejects.toThrow('Duplicate source');
  });
  test('GitHub issue pulls cannot alter projects', async () => {
    const { owner, workspace, project } = await setup();
    await expect(owner.mutation(api.imports.apply, { workspace, batch: batch([project], 'github') })).rejects.toThrow('projects');
  });
});
describe('repository URL validation', () => {
  test('accepts repository URLs and rejects credential-bearing, script, and unrelated URLs', () => {
    expect(repositoryUrlSchema.parse('https://github.com/bessim-dev/lux')).toBe('https://github.com/bessim-dev/lux');
    for (const value of [
      'javascript:alert(1)',
      'https://token@github.com/org/repo',
      'https://github.com/org/repo/issues',
      'https://example.com/org/repo',
      'https://github.com/org/repo?token=x',
    ])
      expect(repositoryUrlSchema.safeParse(value).success).toBe(false);
  });
});
