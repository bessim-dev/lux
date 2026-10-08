import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT-shaped fixture. Nothing here is verified locally; the fake backend accepts or rejects by string. */
export function jwt(claims: Record<string, unknown> = {}): string {
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'fixture', aud: 'convex', exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.${Buffer.from('fixture-signature-0123456789').toString('base64url')}`;
}

/** Writes `cred.json` in `dir` with an owner-only mode by default. */
export async function writeCredential(dir: string, content: Record<string, unknown> | string, mode = 0o600): Promise<string> {
  const path = join(dir, 'cred.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), { mode });
  await chmod(path, mode);
  return path;
}

export interface FakeRequest {
  path: string;
  authorization: string | undefined;
  args: Record<string, unknown>;
}
export type FakeHandler = (args: Record<string, unknown>) => { value: unknown } | { error: string; data?: string } | { status: number; body: string };

/** A local stand-in for a Convex deployment's HTTP query API, so the real `ConvexHttpClient` is exercised. */
export async function fakeConvex(handlers: Record<string, FakeHandler>) {
  const { createServer } = await import('node:http');
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const parsed = typeof body === 'object' && body !== null ? body : {};
      const path = 'path' in parsed && typeof parsed.path === 'string' ? parsed.path : '';
      const rawArgs = 'args' in parsed && Array.isArray(parsed.args) ? parsed.args[0] : {};
      const args = typeof rawArgs === 'object' && rawArgs !== null ? { ...rawArgs } : {};
      requests.push({ path, authorization: req.headers.authorization, args });
      const outcome = handlers[path]?.(args) ?? { error: 'no such function' };
      res.setHeader('content-type', 'application/json');
      if ('value' in outcome) res.end(JSON.stringify({ status: 'success', value: outcome.value, logLines: [] }));
      else if ('body' in outcome) res.writeHead(outcome.status).end(outcome.body);
      else res.writeHead(560).end(JSON.stringify({ status: 'error', errorMessage: outcome.error, errorData: outcome.data, logLines: [] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const member = { id: 'member_1', role: 'Member' };
export const workspaces = [
  { id: 'ws_1', name: 'Reotech' },
  { id: 'ws_2', name: 'Other' },
];
export const projects = [
  { id: 'proj_1', key: 'LUX', name: 'Lux' },
  { id: 'proj_2', key: 'OPS', name: 'Operations' },
];
export const task = (n: number, title = `Task ${n}`) => ({
  id: `task_${n}`,
  key: `LUX-${n}`,
  title,
  status: 'todo',
  assignee: null,
  priority: 'none',
  due: null,
  updated: 1000 + n,
});

/** Handlers shaped like convex/agent.ts responses. */
export function standardHandlers(): Record<string, FakeHandler> {
  const page = { cursor: null, isDone: true };
  return {
    'agent:context': args => {
      if (typeof args['workspace'] !== 'string') return { value: { kind: 'workspaces', workspaces, page } };
      const workspace = workspaces.find(w => w.id === args['workspace']);
      if (!workspace) return { error: 'x', data: 'You do not have access to this workspace.' };
      if (typeof args['project'] !== 'string') return { value: { kind: 'projects', workspace, member, projects, page } };
      const project = projects.find(p => p.id === args['project']);
      if (!project) return { error: 'x', data: 'Project is unavailable.' };
      return { value: { kind: 'selection', selection: { workspace, project, member } } };
    },
    'agent:search': args => ({ value: { tasks: [task(1, `match ${String(args['query'] ?? '')}`), task(2)], page } }),
    'agent:get': args => ({
      value: {
        task: task(7),
        ...(args['includeDescription'] === true ? { description: 'Details', descriptionTruncated: false } : {}),
        pullRequests: [],
      },
    }),
  };
}
