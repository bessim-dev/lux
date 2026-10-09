import { v } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { access, allEntities, decode, canEdit, canRead, fail, put } from './access';
import { fileSchema } from '../shared/model';

export const uploadUrl = mutation({
  args: { workspace: v.id('workspaces'), project: v.string() },
  handler: async (ctx, args) => {
    const { member } = await access(ctx, args.workspace);
    const project = (await allEntities(ctx, args.workspace)).map(r => decode(r.payload)).find(e => e.kind === 'projects' && e.value.id === args.project);
    if (project?.kind !== 'projects' || !canEdit(project.value, member)) return fail('No permission to upload here.');
    return ctx.storage.generateUploadUrl();
  },
});
export async function finishUpload(ctx: MutationCtx, args: { workspace: Id<'workspaces'>; storage: string; file: string }) {
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
}

export const finish = mutation({
  args: { workspace: v.id('workspaces'), storage: v.string(), file: v.string() },
  handler: async (ctx, args) => {
    await finishUpload(ctx, args);
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
