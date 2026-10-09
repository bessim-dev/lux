import { v } from 'convex/values';
import { mutation, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { access, fail, decode, canEdit, put } from './access';
import { importBatchSchema } from '../shared/imports';
import { equal, memberSchema } from '../shared/model';

async function entityRow(ctx: MutationCtx, workspace: Id<'workspaces'>, kind: 'projects' | 'tasks' | 'comments', key: string) {
  return ctx.db
    .query('entities')
    .withIndex('by_key', q => q.eq('workspace', workspace).eq('kind', kind).eq('key', key))
    .unique();
}

// Imports preserve source author/time but require the actual destination owner.
// They never create identities, grant membership, delete records, or bypass private-project access.
export const apply = mutation({
  args: { workspace: v.id('workspaces'), batch: v.string() },
  handler: async (ctx, args) => {
    const { member, user } = await access(ctx, args.workspace);
    const workspace = await ctx.db.get(args.workspace);
    if (workspace?.owner !== user.tokenIdentifier || member.role !== 'Owner') return fail('Only the workspace owner can import.');
    if (args.batch.length > 1000000) return fail('Import batch exceeds 1 MB.');
    const batch = importBatchSchema.parse(JSON.parse(args.batch));
    const rows = await ctx.db
      .query('entities')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(4001);
    if (rows.length > 4000) return fail('Import exceeds the 4000-record safety limit. Paginate the workspace UI before a larger import.');
    const members = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .take(501);
    if (members.length > 500) return fail('Import supports up to 500 members.');
    const memberIds = new Set(members.map(row => memberSchema.parse(JSON.parse(row.profile)).id));
    const results: Array<{ sourceId: string; key: string; status: 'created' | 'updated' | 'unchanged' | 'conflict' }> = [];
    const seen = new Set<string>();
    let count = rows.length;
    for (const record of batch.records) {
      const { entity } = record;
      const source = `${entity.kind}:${record.sourceId}`;
      if (seen.has(source)) return fail('Duplicate source record in one batch.');
      seen.add(source);
      const mapping = await ctx.db
        .query('importRecords')
        .withIndex('by_source', q =>
          q
            .eq('workspace', args.workspace)
            .eq('provider', batch.provider)
            .eq('namespace', batch.namespace)
            .eq('kind', entity.kind)
            .eq('sourceId', record.sourceId),
        )
        .unique();
      const key = entity.value.id;
      if (mapping && mapping.key !== key) return fail('Source identity cannot be rebound.');
      const current = await entityRow(ctx, args.workspace, entity.kind, key);
      const payload = JSON.stringify(entity);
      if (!current && !mapping && ++count > 4000) return fail('Import exceeds the 4000-record safety limit.');
      const previous = current ? decode(current.payload) : null;
      if (previous?.kind === 'projects' && entity.kind === 'projects' && previous.value.key !== entity.value.key)
        return fail('Import cannot change project keys.');
      if (previous?.kind === 'tasks' && entity.kind === 'tasks' && (previous.value.project !== entity.value.project || previous.value.key !== entity.value.key))
        return fail('Import cannot move tasks or change their keys.');
      if ((!mapping && current) || (mapping && (!current || !equal(decode(current.payload), decode(mapping.appliedPayload))))) {
        results.push({ sourceId: record.sourceId, key, status: 'conflict' });
        continue;
      }
      if (entity.kind === 'projects') {
        if (batch.provider !== 'plane') return fail('GitHub imports cannot create or replace projects.');
        if (current) {
          const project = decode(current.payload);
          if (project.kind !== 'projects' || !canEdit(project.value, member)) return fail('Cannot import into this project.');
        }
        if (entity.value.access === 'link') return fail('Public project sharing is not supported.');
        if (!entity.value.members.includes(member.id) || entity.value.lead !== member.id)
          return fail('Imported projects must retain the owner as lead and member.');
        if (entity.value.members.some(id => !memberIds.has(id))) return fail('Unknown project member.');
        for (const row of await ctx.db
          .query('entities')
          .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'projects'))
          .take(501)) {
          if (row.kind === 'projects' && row.key !== key) {
            const project = decode(row.payload);
            if (project.kind === 'projects' && project.value.key === entity.value.key) return fail('Project key already exists.');
          }
        }
      } else {
        const taskRow = entity.kind === 'comments' ? await entityRow(ctx, args.workspace, 'tasks', entity.value.task) : null;
        const task = taskRow ? decode(taskRow.payload) : null;
        if (entity.kind === 'comments' && task?.kind !== 'tasks') return fail('Unknown comment task.');
        const projectId = entity.kind === 'tasks' ? entity.value.project : task?.kind === 'tasks' ? task.value.project : '';
        const projectRow = await entityRow(ctx, args.workspace, 'projects', projectId);
        const project = projectRow ? decode(projectRow.payload) : null;
        if (project?.kind !== 'projects' || !canEdit(project.value, member)) return fail('Cannot import into this project.');
        if (entity.kind === 'comments') {
          if (!memberIds.has(entity.value.by)) return fail('Unknown comment author.');
          if (Object.keys(entity.value.re).length) return fail('Imported reactions are not supported.');
        } else {
          if (entity.value.assignee && !memberIds.has(entity.value.assignee)) return fail('Unknown assignee.');
          if (entity.value.attachments.length || entity.value.subtasks.length || entity.value.deps.length)
            return fail('Import files and relationships through their dedicated workflows.');
          const match = new RegExp(`^${project.value.key}-([1-9][0-9]*)$`).exec(entity.value.key);
          const sequence = match ? Number(match[1]) : NaN;
          if (!Number.isSafeInteger(sequence)) return fail('Invalid imported task key.');
          const duplicate = await ctx.db
            .query('entities')
            .withIndex('by_task_key', q => q.eq('workspace', args.workspace).eq('kind', 'tasks').eq('project', projectId).eq('taskKey', entity.value.key))
            .first();
          if (duplicate && duplicate.key !== key) return fail('Task key already exists.');
          const counter = await ctx.db
            .query('counters')
            .withIndex('by_project', q => q.eq('workspace', args.workspace).eq('project', projectId))
            .unique();
          if (counter && counter.next < sequence) await ctx.db.patch(counter._id, { next: sequence });
          else if (!counter) await ctx.db.insert('counters', { workspace: args.workspace, project: projectId, next: sequence });
        }
      }
      const unchanged = current && equal(decode(current.payload), entity);
      if (!unchanged) await put(ctx, args.workspace, entity);
      const checkpoint = { key, appliedPayload: payload, raw: record.raw, importedBy: member.id, importedAt: Date.now() };
      if (mapping) await ctx.db.patch(mapping._id, checkpoint);
      else
        await ctx.db.insert('importRecords', {
          ...checkpoint,
          workspace: args.workspace,
          provider: batch.provider,
          namespace: batch.namespace,
          kind: entity.kind,
          sourceId: record.sourceId,
        });
      results.push({ sourceId: record.sourceId, key, status: unchanged ? 'unchanged' : current ? 'updated' : 'created' });
    }
    return results;
  },
});
