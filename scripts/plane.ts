import { z } from 'zod';
import { parsePullRequestUrl } from '../shared/pull-requests';
import { importEntitySchema, type ImportBatch } from '../shared/imports';

const timestamp = z.string().nullable().optional();
const reference = z.string().nullable().optional();
const member = z.object({ id: z.string(), email: z.string(), first_name: z.string().optional(), last_name: z.string().optional() }).passthrough();
const project = z
  .object({
    id: z.string(),
    name: z.string(),
    identifier: z.string(),
    description: z.string().nullable().optional(),
    network: z.number(),
    archived_at: timestamp,
  })
  .passthrough();
const state = z.object({ id: z.string(), name: z.string(), group: z.string() }).passthrough();
const label = z.object({ id: z.string(), name: z.string() }).passthrough();
const task = z
  .object({
    id: z.string(),
    name: z.string(),
    sequence_id: z.number().int().positive(),
    state: z.string(),
    priority: z.string(),
    assignees: z.array(z.string()),
    labels: z.array(z.string()),
    parent: reference,
    created_by: reference,
    created_at: z.string(),
    updated_at: z.string(),
    start_date: reference,
    target_date: reference,
    description_stripped: z.string().nullable().optional(),
    description_html: z.string().nullable().optional(),
    archived_at: timestamp,
  })
  .passthrough();
const comment = z
  .object({
    id: z.string(),
    actor: z.string().nullable().optional(),
    created_by: reference,
    created_at: z.string(),
    comment_stripped: z.string().nullable().optional(),
    comment_html: z.string().nullable().optional(),
  })
  .passthrough();
export const planeExportSchema = z.object({
  version: z.literal(1),
  source: z.literal('https://plane.reotech.org'),
  workspace: z.literal('reotech_internal'),
  exportedAt: z.string(),
  members: z.array(member),
  projects: z.array(
    z.object({
      project,
      states: z.array(state),
      labels: z.array(label),
      members: z.array(z.object({ id: z.string() }).passthrough()),
      tasks: z.array(z.object({ task, comments: z.array(comment), attachments: z.array(z.unknown()), links: z.array(z.unknown()) })),
      cycles: z.array(z.unknown()),
      modules: z.array(z.unknown()),
    }),
  ),
});
export type PlaneExport = z.infer<typeof planeExportSchema>;
const page = z.object({
  results: z.array(z.unknown()),
  next_page_results: z.boolean(),
  next_cursor: z.string().nullable(),
  total_results: z.number().optional(),
});

export async function exportPlane(apiKey: string, legacy: boolean): Promise<PlaneExport> {
  const root = 'https://plane.reotech.org/api/v1/workspaces/reotech_internal/';
  async function request(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const response = await fetch(root + path, { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(30000) });
      if (response.ok) return response.json();
      if (response.status !== 429 || attempt === 3) throw new Error(`Plane ${response.status} for ${path.split('?')[0]}. No source data was changed.`);
      const retry = response.headers.get('Retry-After');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 30;
      if (seconds > 60) throw new Error('Plane rate limit requires a later export retry.');
      console.error(`Plane rate limit. Retrying this read in ${seconds}s.`);
      await new Promise(resolve => setTimeout(resolve, Math.max(1, seconds) * 1000));
    }
    throw new Error('Plane retry limit reached.');
  }
  async function list(path: string): Promise<unknown[]> {
    const rows: unknown[] = [],
      seen = new Set<string>();
    let cursor = '';
    for (;;) {
      const response = await request(path + '?per_page=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      if (Array.isArray(response)) return response;
      const result = page.parse(response);
      rows.push(...result.results);
      if (!result.next_page_results) break;
      if (!result.next_cursor || seen.has(result.next_cursor)) throw new Error('Plane returned a repeated or missing pagination cursor.');
      cursor = result.next_cursor;
      seen.add(cursor);
    }
    return rows;
  }
  const members = z.array(member).parse(await list('members/'));
  const projects = z.array(project.pick({ id: true })).parse(await list('projects/'));
  const output: PlaneExport = {
    version: 1,
    source: 'https://plane.reotech.org',
    workspace: 'reotech_internal',
    exportedAt: new Date().toISOString(),
    members,
    projects: [],
  };
  for (const item of projects) {
    const base = `projects/${item.id}/`,
      issuePath = base + (legacy ? 'issues/' : 'work-items/');
    const detail = project.parse(await request(base));
    const states = z.array(state).parse(await list(base + 'states/'));
    const labels = z.array(label).parse(await list(base + 'labels/'));
    const projectMembers = z.array(z.object({ id: z.string() }).passthrough()).parse(await list(base + 'members/'));
    const tasks = z.array(task).parse(await list(issuePath));
    const entries: PlaneExport['projects'][number]['tasks'] = [];
    for (const item of tasks) {
      const comments = z.array(comment).parse(await list(issuePath + item.id + '/comments/'));
      const attachments = await list(issuePath + item.id + (legacy ? '/issue-attachments/' : '/attachments/'));
      const links = await list(issuePath + item.id + '/' + 'links/');
      entries.push({ task: item, comments, attachments, links });
    }
    output.projects.push({
      project: detail,
      states,
      labels,
      members: projectMembers,
      tasks: entries,
      cycles: await list(base + 'cycles/'),
      modules: await list(base + 'modules/'),
    });
  }
  return planeExportSchema.parse(output);
}

function time(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid source timestamp.');
  return result;
}
function plain(value: string): string {
  return value
    .replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}
export function mapPlane(input: PlaneExport, owner: string, members: ReadonlyMap<string, string>) {
  const records: ImportBatch['records'] = [],
    warnings: string[] = [],
    pullRequestLinks: Array<{ task: string; url: string }> = [];
  const status: Record<string, 'backlog' | 'todo' | 'progress' | 'done'> = {
    backlog: 'backlog',
    unstarted: 'todo',
    started: 'progress',
    completed: 'done',
    cancelled: 'backlog',
  };
  for (const bundle of input.projects) {
    const source = bundle.project,
      projectId = 'plane_p_' + source.id;
    if (bundle.cycles.length || bundle.modules.length)
      warnings.push(`${source.identifier}: ${bundle.cycles.length} cycles and ${bundle.modules.length} modules retained in export only.`);
    records.push({
      sourceId: source.id,
      raw: JSON.stringify(source),
      entity: importEntitySchema.parse({
        kind: 'projects',
        value: {
          id: projectId,
          key: source.identifier,
          name: source.name,
          icon: 'folder',
          color: 'indigo',
          status: source.archived_at ? 'complete' : 'active',
          team: '',
          lead: owner,
          due: null,
          start: null,
          fav: false,
          members: [...new Set([owner, ...bundle.members.flatMap(m => (members.get(m.id) ? [members.get(m.id)] : []))])],
          desc: source.description || '',
          milestones: [],
          last: 0,
          private: source.network === 0,
          access: source.network === 0 ? 'private' : 'workspace',
          archived: !!source.archived_at,
        },
      }),
    });
    for (const entry of bundle.tasks) {
      const source = entry.task,
        taskId = 'plane_t_' + source.id;
      const state = bundle.states.find(s => s.id === source.state);
      if (!state || !status[state.group]) throw new Error(`Unmapped state for ${source.id}.`);
      const assignee = source.assignees.length ? members.get(source.assignees[0]!) : null;
      if (source.assignees.length && !assignee) throw new Error(`Unmapped assignee for ${source.id}.`);
      if (source.assignees.length > 1) warnings.push(`${source.id}: additional assignees retained in provenance only.`);
      if (state.group === 'cancelled') warnings.push(`${source.id}: cancelled mapped to archived backlog.`);
      if (source.parent) warnings.push(`${source.id}: parent relationship retained in provenance only.`);
      if (entry.attachments.length) warnings.push(`${source.id}: ${entry.attachments.length} attachments retained in export only.`);
      for (const link of entry.links) {
        const parsed = z.object({ url: z.string() }).parse(link);
        try {
          pullRequestLinks.push({ task: taskId, url: parsePullRequestUrl(parsed.url).url });
        } catch {
          warnings.push(`${source.id}: unsupported external link retained in export only.`);
        }
      }
      const labels = source.labels.map(id => {
        const name = bundle.labels.find(l => l.id === id)?.name;
        if (!name) throw new Error('Unmapped label.');
        return name;
      });
      records.push({
        sourceId: source.id,
        raw: JSON.stringify(source),
        entity: importEntitySchema.parse({
          kind: 'tasks',
          value: {
            id: taskId,
            project: projectId,
            key: `${bundle.project.identifier}-${source.sequence_id}`,
            title: source.name,
            status: status[state.group],
            assignee: assignee || null,
            priority: source.priority,
            due: source.target_date || null,
            start: source.start_date || null,
            labels,
            subtasks: [],
            attachments: [],
            deps: [],
            desc: source.description_stripped || plain(source.description_html || ''),
            estimate: null,
            created: time(source.created_at),
            updated: time(source.updated_at),
            order: typeof source.sort_order === 'number' ? source.sort_order : source.sequence_id,
            fav: false,
            recur: null,
            archived: !!source.archived_at || state.group === 'cancelled',
          },
        }),
      });
      for (const source of entry.comments) {
        const author = source.actor || source.created_by,
          by = author ? members.get(author) : null;
        if (!by) throw new Error(`Unmapped author for comment ${source.id}.`);
        records.push({
          sourceId: source.id,
          raw: JSON.stringify(source),
          entity: importEntitySchema.parse({
            kind: 'comments',
            value: {
              id: 'plane_c_' + source.id,
              task: taskId,
              by,
              at: time(source.created_at),
              text: source.comment_stripped || plain(source.comment_html || ''),
              re: {},
            },
          }),
        });
      }
    }
  }
  return { records, warnings, pullRequestLinks };
}
