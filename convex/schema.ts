import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const kind = v.union(...(['projects', 'tasks', 'comments', 'activity', 'files', 'teams', 'events', 'savedViews'] as const).map(v.literal));
export default defineSchema({
  workspaces: defineTable({ name: v.string(), url: v.string(), c: v.string(), owner: v.string() }),
  memberships: defineTable({ workspace: v.id('workspaces'), email: v.string(), identity: v.optional(v.string()), profile: v.string() })
    .index('by_identity', ['identity'])
    .index('by_email', ['email'])
    .index('by_workspace', ['workspace']),
  counters: defineTable({ workspace: v.id('workspaces'), project: v.string(), next: v.number() }).index('by_project', ['workspace', 'project']),
  entities: defineTable({ workspace: v.id('workspaces'), kind, key: v.string(), payload: v.string() })
    .index('by_workspace', ['workspace'])
    .index('by_key', ['workspace', 'kind', 'key']),
  uploads: defineTable({ workspace: v.id('workspaces'), file: v.string(), storage: v.id('_storage'), by: v.string() })
    .index('by_workspace_file', ['workspace', 'file'])
    .index('by_storage', ['storage']),
});
