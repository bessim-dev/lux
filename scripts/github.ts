import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { repositoryUrlSchema } from '../shared/repository';
import { importEntitySchema, type ImportBatch } from '../shared/imports';
const exec = promisify(execFile);
const issueSchema = z
  .object({
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(['open', 'closed']),
    created_at: z.string(),
    updated_at: z.string(),
    html_url: z.string(),
    pull_request: z.unknown().optional(),
    labels: z.array(z.object({ name: z.string() })),
  })
  .passthrough();
export type GithubIssue = z.infer<typeof issueSchema>;

export function mapGithubIssue(
  issue: GithubIssue,
  repositoryId: number,
  project: string,
  projectKey: string,
  sequence: number,
): ImportBatch['records'][number] {
  const created = Date.parse(issue.created_at),
    updated = Date.parse(issue.updated_at);
  if (!Number.isFinite(created) || !Number.isFinite(updated)) throw new Error('Invalid GitHub issue timestamp.');
  return {
    sourceId: String(issue.id),
    raw: JSON.stringify(issue),
    entity: importEntitySchema.parse({
      kind: 'tasks',
      value: {
        id: `github_t_${repositoryId}_${issue.id}`,
        project,
        key: `${projectKey}-${sequence}`,
        title: issue.title,
        status: issue.state === 'closed' ? 'done' : 'todo',
        assignee: null,
        priority: 'none',
        due: null,
        start: null,
        labels: issue.labels.map(l => l.name),
        subtasks: [],
        attachments: [],
        deps: [],
        desc: `${issue.body || ''}\n\nSource: ${issue.html_url}`.trim(),
        estimate: null,
        created,
        updated,
        order: issue.number,
        fav: false,
        recur: null,
      },
    }),
  };
}
export async function exportGithub(repositoryUrl: string) {
  repositoryUrlSchema.parse(repositoryUrl);
  if (!repositoryUrl) throw new Error('Repository URL is required.');
  const path = new URL(repositoryUrl).pathname.replace(/^\/|\/$/g, '');
  async function api(path: string, paginate = false): Promise<unknown> {
    const { stdout } = await exec('gh', ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])], { maxBuffer: 20000000 });
    return JSON.parse(stdout);
  }
  const repo = z
    .object({ id: z.number().int().positive(), full_name: z.string(), html_url: z.string(), permissions: z.object({ pull: z.boolean() }).optional() })
    .parse(await api(`repos/${path}`));
  // Immutable ID prevents a rename/recreation from silently mixing issue histories.
  if (repo.html_url.toLowerCase().replace(/\/$/, '') !== repositoryUrl.toLowerCase().replace(/\/$/, ''))
    throw new Error('Repository moved. Update its URL explicitly.');
  const pages = z.array(z.array(issueSchema)).parse(await api(`repos/${path}/issues?state=all&per_page=100`, true));
  const issues = pages.flat().filter(issue => !issue.pull_request);
  return { repository: repo, issues };
}
