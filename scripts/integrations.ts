import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ConvexHttpClient } from 'convex/browser';
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import { agentWorkspaceSchema } from '../shared/agent';
import { importBatchSchema, type ImportBatch } from '../shared/imports';
import { planeExportSchema, exportPlane, mapPlane } from './plane';
import { exportGithub, mapGithubIssue } from './github';
import { loadCredential } from '../agent/credentials';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    export: { type: 'string' },
    plan: { type: 'string' },
    owner: { type: 'string' },
    'member-map': { type: 'string' },
    instance: { type: 'string' },
    workspace: { type: 'string' },
    'credential-file': { type: 'string' },
    repository: { type: 'string' },
    project: { type: 'string' },
    'project-key': { type: 'string' },
    legacy: { type: 'boolean' },
    apply: { type: 'boolean' },
  },
});
const required = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`--${name} is required.`);
  return value;
};
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
const save = async (value: unknown) => writeFile(required('out'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const importRef = makeFunctionReference<'mutation', { workspace: string; batch: string }, unknown>('imports:apply');
const linkRef = makeFunctionReference<'mutation', { workspace: string; task: string; url: string }, unknown>('pullRequestLinks:add');
const resultSchema = z.array(z.object({ sourceId: z.string(), key: z.string(), status: z.enum(['created', 'updated', 'unchanged', 'conflict']) }));
const planSchema = z.object({
  provider: importBatchSchema.shape.provider,
  namespace: importBatchSchema.shape.namespace,
  records: z.array(importBatchSchema.shape.records.element).max(4000),
  warnings: z.array(z.string()),
  pullRequestLinks: z.array(z.object({ task: z.string(), url: z.string() })).default([]),
});

export async function applyPlan(plan: z.infer<typeof planSchema>, send: (batch: ImportBatch) => Promise<Array<{ status: string }>>) {
  const results: Array<{ status: string }> = [];
  for (let offset = 0; offset < plan.records.length; offset += 25) {
    const batch = importBatchSchema.parse({ ...plan, records: plan.records.slice(offset, offset + 25) });
    const result = await send(batch);
    results.push(...result);
    if (result.some(r => r.status === 'conflict'))
      throw new Error(`Import conflict in batch ${offset / 25 + 1}. Local changes were preserved. Review before resuming.`);
  }
  return results;
}
async function main() {
  switch (positionals[0]) {
    case 'plane-export': {
      const key = process.env.PLANE_API_KEY;
      if (!key) throw new Error('PLANE_API_KEY must be set in the process environment.');
      const result = await exportPlane(key, !!values.legacy);
      await save(result);
      console.log(
        JSON.stringify({ projects: result.projects.length, tasks: result.projects.reduce((n, p) => n + p.tasks.length, 0), export: required('out') }),
      );
      return;
    }
    case 'plane-plan': {
      const input = planeExportSchema.parse(await json(required('export')));
      const memberMap = z.record(z.string(), z.string()).parse(await json(required('member-map')));
      const mapped = mapPlane(input, required('owner'), new Map(Object.entries(memberMap)));
      const plan = planSchema.parse({ ...mapped, provider: 'plane', namespace: `${input.source}/${input.workspace}` });
      await save(plan);
      console.log(JSON.stringify({ records: plan.records.length, warnings: plan.warnings }));
      return;
    }
    case 'github-plan': {
      const source = await exportGithub(required('repository'));
      // A fresh project can use issue numbers as native keys. Existing projects must supply an
      // explicit mapping rather than renumbering previously imported issues during retries.
      const records = source.issues.map(issue => mapGithubIssue(issue, source.repository.id, required('project'), required('project-key'), issue.number));
      const plan = planSchema.parse({
        provider: 'github',
        namespace: `https://github.com/repositories/${source.repository.id}`,
        records,
        warnings: ['Pull only. Assignee accounts are retained in source metadata. Comments are not imported by this issue pull. PRs are separate from issues.'],
      });
      await save(plan);
      console.log(JSON.stringify({ repository: source.repository, issues: source.issues.length, plan: required('out') }));
      return;
    }
    case 'apply': {
      if (!values.apply) throw new Error('Review the plan, then add --apply to write it.');
      const plan = planSchema.parse(await json(required('plan')));
      const credential = await loadCredential(values['credential-file'], { allowLoopbackHttp: required('instance').startsWith('http://127.0.0.1:') });
      if (credential.instance !== required('instance').replace(/\/$/, '')) throw new Error('Credential belongs to a different instance.');
      const workspace = agentWorkspaceSchema.shape.id.parse(required('workspace'));
      const client = new ConvexHttpClient(credential.instance);
      client.setAuth(credential.token);
      // Match the existing agent backend boundary: opaque strings in the CLI, validated v.id on Convex.
      const results = await applyPlan(plan, async batch => resultSchema.parse(await client.mutation(importRef, { workspace, batch: JSON.stringify(batch) })));
      for (const link of plan.pullRequestLinks) await client.mutation(linkRef, { workspace, ...link });
      console.log(JSON.stringify({ records: results.length, links: plan.pullRequestLinks.length, results }));
      return;
    }
    default:
      throw new Error('Use plane-export, plane-plan, github-plan, or apply. See docs/import-and-sync.md.');
  }
}
if (process.argv[1]?.endsWith('integrations.mjs'))
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Integration failed.');
    process.exitCode = 1;
  });
