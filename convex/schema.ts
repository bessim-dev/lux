import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const kind = v.union(...(['projects', 'tasks', 'comments', 'activity', 'files', 'teams', 'events', 'savedViews'] as const).map(v.literal));
export default defineSchema({
  workspaces: defineTable({ name: v.string(), url: v.string(), c: v.string(), owner: v.string() }),
  importRecords: defineTable({
    workspace: v.id('workspaces'),
    provider: v.union(v.literal('plane'), v.literal('github')),
    namespace: v.string(),
    sourceId: v.string(),
    kind: v.union(v.literal('projects'), v.literal('tasks'), v.literal('comments')),
    key: v.string(),
    appliedPayload: v.string(),
    raw: v.string(),
    importedBy: v.string(),
    importedAt: v.number(),
  })
    .index('by_source', ['workspace', 'provider', 'namespace', 'kind', 'sourceId'])
    .index('by_workspace', ['workspace']),
  memberships: defineTable({ workspace: v.id('workspaces'), email: v.string(), identity: v.optional(v.string()), profile: v.string() })
    .index('by_identity', ['identity'])
    .index('by_identity_workspace', ['identity', 'workspace'])
    .index('by_email', ['email'])
    .index('by_workspace', ['workspace']),
  counters: defineTable({ workspace: v.id('workspaces'), project: v.string(), next: v.number() }).index('by_project', ['workspace', 'project']),
  agentIndexState: defineTable({
    name: v.literal('tasks-v1'),
    status: v.union(v.literal('running'), v.literal('ready')),
    cursor: v.union(v.string(), v.null()),
    processed: v.number(),
  }).index('by_name', ['name']),
  entities: defineTable({
    workspace: v.id('workspaces'),
    kind,
    key: v.string(),
    payload: v.string(),
    project: v.optional(v.string()),
    taskKey: v.optional(v.string()),
    status: v.optional(v.union(v.literal('backlog'), v.literal('todo'), v.literal('progress'), v.literal('review'), v.literal('done'))),
    assignee: v.optional(v.union(v.string(), v.null())),
    searchText: v.optional(v.string()),
  })
    .index('by_workspace', ['workspace'])
    .index('by_key', ['workspace', 'kind', 'key'])
    .index('by_project', ['workspace', 'kind', 'project', 'status', 'assignee'])
    .index('by_project_assignee', ['workspace', 'kind', 'project', 'assignee'])
    .index('by_task_key', ['workspace', 'kind', 'project', 'taskKey'])
    .searchIndex('search_tasks', { searchField: 'searchText', filterFields: ['workspace', 'kind', 'project', 'status', 'assignee'] }),
  uploads: defineTable({ workspace: v.id('workspaces'), file: v.string(), storage: v.id('_storage'), by: v.string() })
    .index('by_workspace_file', ['workspace', 'file'])
    .index('by_storage', ['storage']),
  pullRequestLinks: defineTable({
    workspace: v.id('workspaces'),
    project: v.string(),
    task: v.string(),
    provider: v.union(v.literal('github'), v.literal('forgejo')),
    host: v.string(),
    owner: v.string(),
    repository: v.string(),
    number: v.number(),
    url: v.string(),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index('by_task', ['workspace', 'task'])
    .index('by_project', ['workspace', 'project']),
});
