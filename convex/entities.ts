import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { access, allEntities, canEdit, canRead, decode, fail, projectOf, put, requirePrivateProjectManager } from './access';
import { entityKey, equal, memberSchema, type Entity } from '../shared/model';

export const apply = mutation({
  args: {
    workspace: v.id('workspaces'),
    changes: v.array(v.object({ before: v.union(v.string(), v.null()), after: v.union(v.string(), v.null()) })),
  },
  handler: async (ctx, args) => {
    const { member, admin } = await access(ctx, args.workspace);
    if (args.changes.length > 500) return fail('Too many changes in one operation.');
    const rows = await allEntities(ctx, args.workspace);
    const current = rows.map(r => decode(r.payload));
    const planned = new Map(current.map(e => [entityKey(e), e]));
    const operations = args.changes.map(op => ({ before: op.before ? decode(op.before) : null, after: op.after ? decode(op.after) : null }));
    const touched = new Set<string>();
    for (const { before, after } of operations) {
      const entity = after || before;
      if (!entity) return fail('Empty change.');
      const key = entityKey(entity);
      if (touched.has(key) || (before && entityKey(before) !== key)) return fail('Invalid change ID.');
      touched.add(key);
      if (!equal(planned.get(key) ?? null, before))
        return fail('Someone changed the same item. Your unsaved draft is available to download; reload before retrying.');
      if (after) planned.set(key, after);
      else planned.delete(key);
    }
    const next = [...planned.values()];
    const membershipRows = await ctx.db
      .query('memberships')
      .withIndex('by_workspace', q => q.eq('workspace', args.workspace))
      .collect();
    const memberIds = new Set(membershipRows.map(r => memberSchema.parse(JSON.parse(r.profile)).id));
    for (const { before, after } of operations) {
      const entity = (after || before)!;
      if (entity.kind === 'teams') {
        if (!admin) return fail('Only admins can manage teams.');
      } else {
        const oldProject = before ? projectOf(before, current) : undefined;
        const newProject = after ? projectOf(after, next) : undefined;
        const project = oldProject || newProject;
        if (!project) return fail('The project is missing.');
        const creatingProject = entity.kind === 'projects' && !before;
        if (creatingProject) {
          if (member.role === 'Guest' || !project.members.includes(member.id) || project.lead !== member.id)
            return fail('New projects must include you as their lead.');
        } else {
          if (!canRead(project, member)) return fail('You do not have access to this project.');
          const commentOnly = entity.kind === 'comments' || entity.kind === 'activity';
          const perm = project.perms?.[member.id];
          if (!canEdit(project, member) && !(commentOnly && perm === 'Can comment')) return fail('You do not have permission to edit this project.');
        }
        if (newProject && oldProject && newProject.id !== oldProject.id && !canEdit(newProject, member)) return fail('You cannot move data into this project.');
        if (entity.kind === 'projects' && before?.kind === 'projects' && after?.kind === 'projects') {
          const securityChanged = ['members', 'perms', 'private', 'access', 'lead'].some(
            k => !equal(Reflect.get(before.value, k), Reflect.get(after.value, k)),
          );
          if ((securityChanged || !after) && !admin && project.lead !== member.id && project.perms?.[member.id] !== 'Full access')
            return fail('Only a project lead or admin can manage project access.');
        }
        if (entity.kind === 'projects' && !after && !admin && project.lead !== member.id) return fail('Only a project lead or admin can delete projects.');
      }
      if (after?.kind === 'projects') {
        requirePrivateProjectManager(
          after.value,
          membershipRows.map(r => memberSchema.parse(JSON.parse(r.profile))),
        );
        if (after.value.members.some(id => !memberIds.has(id)) || (after.value.lead && !memberIds.has(after.value.lead)))
          return fail('Project members must belong to this workspace.');
        if (next.some(e => e.kind === 'projects' && e.value.id !== after.value.id && e.value.key === after.value.key))
          return fail('Choose a unique project key.');
      }
      if (after?.kind === 'tasks') {
        if (after.value.assignee && !memberIds.has(after.value.assignee)) return fail('Assignee must belong to this workspace.');
        for (const dep of after.value.deps) {
          const task = next.find(e => e.kind === 'tasks' && e.value.id === dep);
          const project = task && projectOf(task, next);
          if (!project || !canRead(project, member)) return fail('Dependency is unavailable.');
        }
        if (before?.kind === 'tasks' && (after.value.project !== before.value.project || after.value.key !== before.value.key))
          return fail('Moving tasks between projects is not supported yet.');
        if (!before) {
          const project = projectOf(after, next)!;
          // The server allocates keys transactionally; stale clients cannot duplicate them.
          const counter = await ctx.db
            .query('counters')
            .withIndex('by_project', q => q.eq('workspace', args.workspace).eq('project', project.id))
            .unique();
          const seq =
            Math.max(
              counter?.next || 200,
              ...current
                .filter((e): e is Extract<Entity, { kind: 'tasks' }> => e.kind === 'tasks' && e.value.project === project.id)
                .map(e => Number(e.value.key.split('-').at(-1)) || 0),
            ) + 1;
          after.value.key = `${project.key}-${seq}`;
          if (counter) await ctx.db.patch(counter._id, { next: seq });
          else await ctx.db.insert('counters', { workspace: args.workspace, project: project.id, next: seq });
          after.value.created = Date.now();
        }
        after.value.updated = Date.now();
        // Attachments are derived from persisted uploads, never trusted from the browser.
        after.value.attachments = [];
      }
      if (after?.kind === 'comments') {
        if (!before && after.value.by !== member.id) return fail('Comment author must be you.');
        if (!before) {
          if (Object.values(after.value.re).some(ids => ids.some(id => id !== member.id))) return fail('You can only add your own reactions.');
          after.value.at = Date.now();
        }
        if (before?.kind === 'comments' && (before.value.by !== after.value.by || before.value.at !== after.value.at || before.value.task !== after.value.task))
          return fail('Comment attribution cannot change.');
        if (before?.kind === 'comments') {
          for (const emoji of new Set([...Object.keys(before.value.re), ...Object.keys(after.value.re)])) {
            const previous = (before.value.re[emoji] || []).filter(id => id !== member.id).sort();
            const updated = (after.value.re[emoji] || []).filter(id => id !== member.id).sort();
            if (!equal(previous, updated)) return fail('You can only change your own reactions.');
          }
        }
        if (before?.kind === 'comments' && before.value.by !== member.id && before.value.text !== after.value.text)
          return fail('You can only edit your own comments.');
      }
      if (entity.kind === 'comments' && !after && entity.value.by !== member.id && !admin) return fail('You can only delete your own comments.');
      if (entity.kind === 'activity' && (before || entity.value.by !== member.id)) return fail('Activity records are append-only and attributed to you.');
      if (after?.kind === 'activity') after.value.at = Date.now();
      if (entity.kind === 'files' && !before) return fail('Use the upload endpoint to add a file.');
      if (after?.kind === 'files' && before?.kind === 'files' && !equal({ ...before.value, name: after.value.name, type: after.value.type }, after.value))
        return fail('File associations cannot change.');
    }
    for (const { before, after } of operations) {
      if (after) await put(ctx, args.workspace, after);
      else if (before) {
        const row = rows.find(r => r.kind === before.kind && r.key === before.value.id);
        if (row) await ctx.db.delete(row._id);
      }
    }
    // Remove orphaned project/task children, including ones the stale client did not see.
    const deletedProjects = new Set(operations.filter(o => o.before?.kind === 'projects' && !o.after).map(o => o.before!.value.id));
    const deletedTasks = new Set(operations.filter(o => o.before?.kind === 'tasks' && !o.after).map(o => o.before!.value.id));
    for (const project of deletedProjects) {
      const links = await ctx.db
        .query('pullRequestLinks')
        .withIndex('by_project', q => q.eq('workspace', args.workspace).eq('project', project))
        .collect();
      for (const link of links) await ctx.db.delete(link._id);
    }
    for (const task of deletedTasks) {
      const links = await ctx.db
        .query('pullRequestLinks')
        .withIndex('by_task', q => q.eq('workspace', args.workspace).eq('task', task))
        .collect();
      for (const link of links) await ctx.db.delete(link._id);
    }
    for (const row of await allEntities(ctx, args.workspace)) {
      const e = decode(row.payload);
      const project = projectOf(e, current);
      if ((project && deletedProjects.has(project.id)) || ('task' in e.value && e.value.task && deletedTasks.has(e.value.task))) {
        await ctx.db.delete(row._id);
      }
    }
    const remainingTasks = (await allEntities(ctx, args.workspace))
      .map(r => decode(r.payload))
      .filter((e): e is Extract<Entity, { kind: 'tasks' }> => e.kind === 'tasks');
    const taskIds = new Set(remainingTasks.map(e => e.value.id));
    for (const entity of remainingTasks) {
      const deps = entity.value.deps.filter(id => taskIds.has(id));
      if (deps.length !== entity.value.deps.length) {
        entity.value.deps = deps;
        await put(ctx, args.workspace, entity);
      }
    }
    for (const row of rows) {
      if (row.kind !== 'files') continue;
      const retained = await ctx.db
        .query('entities')
        .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'files').eq('key', row.key))
        .unique();
      if (!retained) {
        const upload = await ctx.db
          .query('uploads')
          .withIndex('by_workspace_file', q => q.eq('workspace', args.workspace).eq('file', row.key))
          .unique();
        if (upload) {
          await ctx.storage.delete(upload.storage);
          await ctx.db.delete(upload._id);
        }
      }
    }
  },
});
