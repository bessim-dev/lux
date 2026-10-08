import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalMutation, internalQuery, mutation, query } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { access, allEntities, decode, canEdit, canRead, fail, put } from './access';
import { fileSchema, type Entity } from '../shared/model';

export const uploadUrl = mutation({
  args: { workspace: v.id('workspaces'), project: v.string() },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const project = (await allEntities(ctx, args.workspace)).map(r => decode(r.payload)).find(e => e.kind === 'projects' && e.value.id === args.project);
    if (project?.kind !== 'projects' || !canEdit(project.value, member)) return fail('No permission to upload here.');
    return ctx.storage.generateUploadUrl();
  },
});
export const finish = mutation({
  args: { workspace: v.id('workspaces'), storage: v.string(), file: v.string() },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const storage = ctx.db.system.normalizeId('_storage', args.storage);
    if (!storage) return fail('Invalid storage ID.');
    const file = fileSchema.parse(JSON.parse(args.file));
    const items = (await allEntities(ctx, args.workspace)).map(r => decode(r.payload));
    const project = items.find(e => e.kind === 'projects' && e.value.id === file.project);
    if (project?.kind !== 'projects' || !canEdit(project.value, member)) return fail('No permission to upload here.');
    if (file.task && !items.some(e => e.kind === 'tasks' && e.value.id === file.task && e.value.project === file.project)) return fail('Task is unavailable.');
    if (items.some(e => e.kind === 'files' && e.value.id === file.id)) return fail('File already exists.');
    const metadata = await ctx.db.system.get(storage);
    if (!metadata || metadata.size > 25 * 1024 * 1024) return fail('File must be 25 MB or smaller.');
    // A storage ID must never be attachable to more than one workspace/file.
    const existing = await ctx.db
      .query('uploads')
      .withIndex('by_storage', q => q.eq('storage', storage))
      .first();
    if (existing) return fail('This upload has already been attached.');
    await ctx.db.insert('uploads', { workspace: args.workspace, file: file.id, storage, by: member.id });
    await put(ctx, args.workspace, { kind: 'files', value: { ...file, size: `${Math.ceil(metadata.size / 1024)} KB`, by: member.id, at: Date.now() } });
  },
});
export const download = query({
  args: { workspace: v.id('workspaces'), file: v.string() },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const items = (await allEntities(ctx, args.workspace)).map(r => decode(r.payload));
    const file = items.find(e => e.kind === 'files' && e.value.id === args.file);
    const project = file?.kind === 'files' && items.find(e => e.kind === 'projects' && e.value.id === file.value.project);
    if (!project || project.kind !== 'projects' || !canRead(project.value, member)) return fail('File is unavailable.');
    const upload = await ctx.db
      .query('uploads')
      .withIndex('by_workspace_file', q => q.eq('workspace', args.workspace).eq('file', args.file))
      .unique();
    if (!upload) return fail('File is unavailable.');
    return ctx.storage.getUrl(upload.storage);
  },
});

const duplicateArgs = { workspace: v.id('workspaces'), file: v.string(), task: v.optional(v.union(v.string(), v.null())) };
type FileEntity = Extract<Entity, { kind: 'files' }>;
type PreparedDuplicate = { source: FileEntity; storage: Id<'_storage'>; task: string | null };

export const prepareDuplicate = internalQuery({
  args: duplicateArgs,
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const sourceRow = await ctx.db
      .query('entities')
      .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'files').eq('key', args.file))
      .unique();
    const source = sourceRow ? decode(sourceRow.payload) : null;
    const projectRow =
      source?.kind === 'files'
        ? await ctx.db
            .query('entities')
            .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'projects').eq('key', source.value.project))
            .unique()
        : null;
    const project = projectRow ? decode(projectRow.payload) : null;
    if (!source || source.kind !== 'files' || !project || project.kind !== 'projects' || !canEdit(project.value, member)) return fail('File is unavailable.');
    const task = args.task ?? source.value.task ?? null;
    if (task) {
      const taskRow = await ctx.db
        .query('entities')
        .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'tasks').eq('key', task))
        .unique();
      const taskEntity = taskRow ? decode(taskRow.payload) : null;
      if (!taskEntity || taskEntity.kind !== 'tasks' || taskEntity.value.project !== source.value.project) return fail('Task is unavailable.');
    }
    const upload = await ctx.db
      .query('uploads')
      .withIndex('by_workspace_file', q => q.eq('workspace', args.workspace).eq('file', source.value.id))
      .unique();
    if (!upload) return fail('File is unavailable.');
    return { source, storage: upload.storage, task };
  },
});

export const finalizeDuplicate = internalMutation({
  args: { workspace: v.id('workspaces'), source: v.string(), sourceStorage: v.string(), task: v.union(v.string(), v.null()), storage: v.string() },
  handler: async (ctx, args) => {
    const storage = ctx.db.system.normalizeId('_storage', args.storage);
    if (!storage) return fail('Invalid storage ID.');
    let ownsStorage = true;
    try {
      const { member } = await access(ctx, args.workspace);
      const sourceRow = await ctx.db
        .query('entities')
        .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'files').eq('key', args.source))
        .unique();
      const source = sourceRow ? decode(sourceRow.payload) : null;
      const projectRow =
        source?.kind === 'files'
          ? await ctx.db
              .query('entities')
              .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'projects').eq('key', source.value.project))
              .unique()
          : null;
      const project = projectRow ? decode(projectRow.payload) : null;
      if (!source || source.kind !== 'files' || !project || project.kind !== 'projects' || !canEdit(project.value, member)) return fail('File is unavailable.');
      if (args.task) {
        const taskRow = await ctx.db
          .query('entities')
          .withIndex('by_key', q => q.eq('workspace', args.workspace).eq('kind', 'tasks').eq('key', args.task!))
          .unique();
        const taskEntity = taskRow ? decode(taskRow.payload) : null;
        if (!taskEntity || taskEntity.kind !== 'tasks' || taskEntity.value.project !== source.value.project) return fail('Task is unavailable.');
      }
      const sourceUpload = await ctx.db
        .query('uploads')
        .withIndex('by_workspace_file', q => q.eq('workspace', args.workspace).eq('file', source.value.id))
        .unique();
      if (!sourceUpload || sourceUpload.storage !== ctx.db.system.normalizeId('_storage', args.sourceStorage)) return fail('File is unavailable.');
      const newMetadata = await ctx.db.system.get(storage);
      if (!newMetadata || newMetadata.size > 25 * 1024 * 1024) return fail('File is unavailable.');
      const existing = await ctx.db
        .query('uploads')
        .withIndex('by_storage', q => q.eq('storage', storage))
        .first();
      if (existing) {
        ownsStorage = false;
        return fail('This upload has already been attached.');
      }
      const file = fileSchema.parse({ ...source.value, id: crypto.randomUUID(), task: args.task });
      await ctx.db.insert('uploads', { workspace: args.workspace, file: file.id, storage, by: source.value.by });
      await put(ctx, args.workspace, { kind: 'files', value: file });
      return file;
    } catch (error) {
      if (ownsStorage) await ctx.storage.delete(storage);
      throw error;
    }
  },
});

export const duplicate = action({
  args: duplicateArgs,
  handler: async (ctx, args): Promise<FileEntity['value']> => {
    const prepared: PreparedDuplicate = await ctx.runQuery(internal.files.prepareDuplicate, args);
    const blob = await ctx.storage.get(prepared.storage);
    if (!blob) return fail('File is unavailable.');
    const storage = await ctx.storage.store(blob);
    try {
      return await ctx.runMutation(internal.files.finalizeDuplicate, {
        workspace: args.workspace,
        source: prepared.source.value.id,
        sourceStorage: prepared.storage,
        task: prepared.task,
        storage,
      });
    } catch (error) {
      await ctx.storage.delete(storage);
      throw error;
    }
  },
});
