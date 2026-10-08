import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMcpServer } from '@reotech/mcp-kit';
import { convexBackend, UPSTREAM_TIMEOUT_MS } from '../agent/backend';
import { runCli } from '../agent/cli';
import { createAgentService } from '../agent/service';
import { LUX_INSTRUCTIONS, createLuxTools } from '../agent/tools';
import { fakeConvex, jwt, standardHandlers, task, writeCredential, type FakeHandler } from './mcp-helpers';

let dir: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lux-agent-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function backend(handlers: Record<string, FakeHandler> = standardHandlers()) {
  const fake = await fakeConvex(handlers);
  cleanups.push(fake.close);
  return fake;
}
const bind = (instance: string, workspace = 'ws_1', project = 'proj_1') => ({ version: 1 as const, instance, workspace, project });

async function connect(options: { instance: string; binding?: ReturnType<typeof bind> | null; credential?: string | undefined; now?: () => number }) {
  const service = createAgentService({
    binding: options.binding === undefined ? bind(options.instance) : options.binding,
    credentialFile: 'credential' in options ? options.credential : await writeCredential(dir, { version: 1, instance: options.instance, token: jwt() }),
    allowLoopbackHttp: true,
    backend: convexBackend,
    ...(options.now ? { now: options.now } : {}),
  });
  const server = createMcpServer({ name: 'lux', version: '0.0.1', instructions: LUX_INSTRUCTIONS, tools: createLuxTools(), resolveContext: () => service });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const text = (result: Awaited<ReturnType<typeof call>>) => JSON.stringify(result.content);

async function unresponsiveBackend(partialBody = false) {
  let received: (() => void) | undefined;
  let disconnected: (() => void) | undefined;
  const started = new Promise<void>(resolve => {
    received = resolve;
  });
  const closed = new Promise<void>(resolve => {
    disconnected = resolve;
  });
  const server = createServer((request, response) => {
    response.once('close', () => disconnected?.());
    request.resume();
    request.once('end', () => {
      if (partialBody) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"status":"success","value":');
      }
      received?.();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${address.port}`, started, closed };
}

describe('Lux upstream deadlines and cancellation', () => {
  test.each([false, true])('times out a real request with partial response body %s and closes its connection', async partialBody => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => realTimeout(ms === UPSTREAM_TIMEOUT_MS ? 100 : ms));
    const fake = await unresponsiveBackend(partialBody);
    await expect(convexBackend(fake.url, jwt()).context({})).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT', retryable: true });
    expect(timeout).toHaveBeenCalledWith(15_000);
    await fake.closed;
  });

  test('returns a safe cancellation code and aborts the underlying fetch', async () => {
    const fake = await unresponsiveBackend();
    const controller = new AbortController();
    const pending = convexBackend(fake.url, jwt(), controller.signal).context({});
    const rejected = expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED', retryable: false });
    await fake.started;
    controller.abort(new Error('opaque-sensitive-cancellation-reason'));
    await rejected;
    await fake.closed;
  });

  test.each(['lux_context', 'lux_search', 'lux_get'])('MCP cancellation of %s closes the backend connection', async name => {
    const fake = await unresponsiveBackend();
    const client = await connect({ instance: fake.url });
    const controller = new AbortController();
    const pending = client.callTool({ name, arguments: name === 'lux_get' ? { task: { key: 'LUX-1' } } : {} }, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await fake.started;
    controller.abort();
    await rejected;
    await fake.closed;
  });
});

describe('Lux catalog', () => {
  test('lists three stable, accurately annotated, concise read-only tools with object output schemas', async () => {
    const fake = await backend();
    const listed = await (await connect({ instance: fake.url })).listTools();
    expect(listed.tools.map(t => t.name)).toEqual(['lux_context', 'lux_search', 'lux_get']);
    for (const tool of listed.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
      expect(tool.description?.length ?? 0).toBeLessThan(200);
    }
    expect(JSON.stringify(listed).length).toBeLessThan(8000);
    expect(JSON.stringify(listed)).not.toContain('instance');
  });
});

describe('Lux tools through the MCP protocol', () => {
  test('lux_context resolves the pinned selection and sends the user token to the pinned instance', async () => {
    const fake = await backend();
    const client = await connect({ instance: fake.url });
    const result = await call(client, 'lux_context');
    expect(result.structuredContent).toMatchObject({ kind: 'selection', selection: { workspace: { id: 'ws_1' }, project: { id: 'proj_1', key: 'LUX' } } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ path: 'agent:context', args: { workspace: 'ws_1', project: 'proj_1' } });
    expect(fake.requests[0]?.authorization).toMatch(/^Bearer eyJ/);
  });

  test('without a binding, lux_context lists authorized workspaces, then projects for an explicit workspace', async () => {
    const fake = await backend();
    const client = await connect({ instance: fake.url, binding: null });
    expect((await call(client, 'lux_context')).structuredContent).toMatchObject({ kind: 'workspaces' });
    expect((await call(client, 'lux_context', { workspace: 'ws_1' })).structuredContent).toMatchObject({
      kind: 'projects',
      projects: [{ id: 'proj_1' }, { id: 'proj_2' }],
    });
  });

  test('lux_search and lux_get default to the pinned scope; explicit project overrides are passed through for the backend to authorize', async () => {
    const fake = await backend();
    const client = await connect({ instance: fake.url });
    const search = await call(client, 'lux_search', { query: 'bug', status: 'todo' });
    expect(search.structuredContent).toMatchObject({ tasks: [{ key: 'LUX-1', title: 'match bug' }, { key: 'LUX-2' }], page: { isDone: true } });
    expect(fake.requests[0]?.args).toMatchObject({ workspace: 'ws_1', project: 'proj_1', query: 'bug', status: 'todo', limit: 20 });
    await call(client, 'lux_search', { project: 'proj_2', limit: 50 });
    expect(fake.requests[1]?.args).toMatchObject({ workspace: 'ws_1', project: 'proj_2', limit: 50 });
    const get = await call(client, 'lux_get', { task: { key: 'LUX-7' } });
    expect(get.structuredContent).toMatchObject({ task: { key: 'LUX-7' }, pullRequests: [] });
    expect(get.structuredContent).not.toHaveProperty('description');
    expect(fake.requests[2]?.args).toMatchObject({ workspace: 'ws_1', project: 'proj_1', task: { key: 'LUX-7' }, includeDescription: false });
    expect((await call(client, 'lux_get', { task: { id: 'task_7' }, includeDescription: true })).structuredContent).toMatchObject({ description: 'Details' });
  });

  test('requires context when nothing is bound, before any request', async () => {
    const fake = await backend();
    const client = await connect({ instance: fake.url, binding: null });
    const result = await call(client, 'lux_search', {});
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('CONTEXT_REQUIRED');
    expect(fake.requests).toHaveLength(0);
  });

  test.each([
    ['limit above 50', 'lux_search', { limit: 51 }],
    ['unknown field', 'lux_search', { destination: 'https://evil.example' }],
    ['instance override', 'lux_context', { instance: 'https://evil.example' }],
    ['project without workspace', 'lux_context', { project: 'proj_1' }],
    ['bad status', 'lux_search', { status: 'weird' }],
    ['task without id or key', 'lux_get', { task: {} }],
  ])('rejects %s with no request', async (_name, tool, args) => {
    const fake = await backend();
    const client = await connect({ instance: fake.url, binding: tool === 'lux_context' && 'project' in args ? null : undefined });
    const result = await call(client, tool, args).catch(() => ({ isError: true }));
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  test('refuses to send the token when the binding names a different instance', async () => {
    const fake = await backend();
    const attacker = await backend();
    const client = await connect({ instance: fake.url, binding: bind(attacker.url) });
    const result = await call(client, 'lux_context');
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('INSTANCE_MISMATCH');
    expect(fake.requests).toHaveLength(0);
    expect(attacker.requests).toHaveLength(0);
  });

  test('re-reads the credential for every call and refuses an expired one without a request', async () => {
    const fake = await backend();
    const credential = await writeCredential(dir, { version: 1, instance: fake.url, token: jwt({ sub: 'first' }) });
    let clock = Date.now();
    const client = await connect({ instance: fake.url, credential, now: () => clock });
    await call(client, 'lux_context');
    const rotated = jwt({ sub: 'second' });
    await writeCredential(dir, { version: 1, instance: fake.url, token: rotated });
    await call(client, 'lux_context');
    expect(fake.requests.map(r => r.authorization)).toEqual([expect.stringMatching(/^Bearer /), `Bearer ${rotated}`]);
    expect(fake.requests[0]?.authorization).not.toBe(fake.requests[1]?.authorization);
    clock += 3_600_000;
    const result = await call(client, 'lux_context');
    expect(text(result)).toContain('AUTH_EXPIRED');
    expect(fake.requests).toHaveLength(2);
  });

  test('keeps concurrent bindings independent', async () => {
    const fake = await backend();
    const [one, two] = await Promise.all([
      connect({ instance: fake.url, binding: bind(fake.url, 'ws_1', 'proj_1') }),
      connect({ instance: fake.url, binding: bind(fake.url, 'ws_2', 'proj_2') }),
    ]);
    const results = await Promise.all([call(one, 'lux_context'), call(two, 'lux_context'), call(one, 'lux_context'), call(two, 'lux_context')]);
    expect(results.map(r => JSON.stringify(r.structuredContent))).toEqual([
      expect.stringContaining('"id":"proj_1"'),
      expect.stringContaining('"id":"proj_2"'),
      expect.stringContaining('"id":"proj_1"'),
      expect.stringContaining('"id":"proj_2"'),
    ]);
  });

  test('maps backend rejections, hides unexpected upstream failures and tokens, and rejects malformed responses', async () => {
    const token = jwt({ sub: 'leaky' });
    const fake = await backend({
      'agent:context': () => ({ error: 'x', data: 'AGENT_CURSOR_INVALID: Restart pagination with the current selection and filters.' }),
      'agent:search': () => ({ status: 500, body: `internal stack for Bearer ${token} at https://u:p@db.internal` }),
      'agent:get': () => ({ value: { task: { id: 'x' } } }),
    });
    const credential = await writeCredential(dir, { version: 1, instance: fake.url, token });
    const client = await connect({ instance: fake.url, credential });
    const rejected = await call(client, 'lux_context');
    expect(text(rejected)).toContain('AGENT_CURSOR_INVALID');
    const down = await call(client, 'lux_search', {});
    expect(text(down)).toContain('UPSTREAM_UNAVAILABLE');
    expect(text(down)).not.toMatch(/internal stack|db\.internal|leaky/);
    expect(text(down)).not.toContain(token);
    const malformed = await call(client, 'lux_get', { task: { key: 'LUX-1' } });
    expect(text(malformed)).toContain('BACKEND_RESPONSE_INVALID');
  });

  test('a full page of maximum-size summaries still fits the output budget', async () => {
    const fake = await backend({
      'agent:search': () => ({ value: { tasks: Array.from({ length: 50 }, (_, i) => task(i, 'x'.repeat(500))), page: { cursor: 'next', isDone: false } } }),
    });
    const result = await call(await connect({ instance: fake.url }), 'lux_search', { limit: 50 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ page: { cursor: 'next', isDone: false } });
  });
});

describe('lux CLI', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) } };
  };
  async function repo(files: Record<string, unknown> = {}) {
    const root = join(dir, 'repo');
    await mkdir(join(root, '.git'), { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), JSON.stringify(content));
    return root;
  }
  const envFor = (credential: string) => ({ LUX_CREDENTIAL_FILE: credential, LUX_ALLOW_INSECURE_LOOPBACK: '1' });

  test('link verifies access before writing a non-secret binding, and will not replace one without --force', async () => {
    const fake = await backend();
    const root = await repo();
    const credential = await writeCredential(dir, { version: 1, instance: fake.url, token: jwt() });
    const run = io();
    const args = ['link', '--instance', fake.url, '--workspace', 'ws_1', '--project', 'proj_1', '--project-dir', root];
    expect(await runCli(args, run.io, envFor(credential))).toBe(0);
    const written = JSON.parse(await readFile(join(root, '.lux.json'), 'utf8'));
    expect(written).toEqual({ version: 1, instance: fake.url, workspace: 'ws_1', project: 'proj_1' });
    expect(JSON.stringify(written)).not.toContain('eyJ');
    expect(run.out.join('')).toContain('LUX');
    const again = io();
    expect(await runCli(args, again.io, envFor(credential))).toBe(1);
    expect(again.err.join('')).toContain('BINDING_EXISTS');
    expect(await runCli([...args, '--force'], io().io, envFor(credential))).toBe(0);
  });

  test('link writes nothing when access cannot be verified or the credential is for another instance', async () => {
    const fake = await backend();
    const other = await backend();
    const root = await repo();
    const credential = await writeCredential(dir, { version: 1, instance: fake.url, token: jwt() });
    const denied = io();
    expect(
      await runCli(['link', '--instance', fake.url, '--workspace', 'ws_9', '--project', 'proj_1', '--project-dir', root], denied.io, envFor(credential)),
    ).toBe(1);
    await expect(readFile(join(root, '.lux.json'))).rejects.toThrow();
    const mismatch = io();
    expect(
      await runCli(['link', '--instance', other.url, '--workspace', 'ws_1', '--project', 'proj_1', '--project-dir', root], mismatch.io, envFor(credential)),
    ).toBe(1);
    expect(mismatch.err.join('')).toContain('INSTANCE_MISMATCH');
    expect(other.requests).toHaveLength(0);
    expect(
      await runCli(
        ['link', '--instance', 'http://example.com', '--workspace', 'ws_1', '--project', 'proj_1', '--project-dir', root],
        io().io,
        envFor(credential),
      ),
    ).toBe(2);
  });

  test('context, search and get print JSON using the discovered binding', async () => {
    const fake = await backend();
    const root = await repo({ '.lux.json': bind(fake.url) });
    const credential = await writeCredential(dir, { version: 1, instance: fake.url, token: jwt() });
    const run = io();
    expect(await runCli(['context', '--project-dir', root], run.io, envFor(credential))).toBe(0);
    expect(await runCli(['search', '--project-dir', root, '--query', 'x', '--unassigned', '--limit', '5'], run.io, envFor(credential))).toBe(0);
    expect(await runCli(['get', 'LUX-7', '--project-dir', root, '--description'], run.io, envFor(credential))).toBe(0);
    expect(JSON.parse(run.out[0] ?? '{}')).toMatchObject({ kind: 'selection' });
    expect(fake.requests[1]?.args).toMatchObject({ query: 'x', assignee: null, limit: 5 });
    expect(fake.requests[2]?.args).toMatchObject({ task: { key: 'LUX-7' }, includeDescription: true });
  });

  test('reports usage errors with exit 2, an invalid closest binding with exit 1, and no project directory for mcp', async () => {
    const root = await repo({ '.lux.json': { version: 9 } });
    const credential = await writeCredential(dir, { version: 1, instance: 'https://lux.example.convex.cloud', token: jwt() });
    expect(await runCli(['nope'], io().io, {})).toBe(2);
    expect(await runCli(['search', '--bogus'], io().io, {})).toBe(2);
    expect(await runCli(['get'], io().io, {})).toBe(2);
    const invalid = io();
    expect(await runCli(['context', '--project-dir', root], invalid.io, envFor(credential))).toBe(1);
    expect(invalid.err.join('')).toContain('BINDING_INVALID');
    const noDir = io();
    expect(await runCli(['mcp'], noDir.io, {})).toBe(1);
    expect(noDir.err.join('')).toContain('PROJECT_DIR_REQUIRED');
    expect(await runCli(['--help'], io().io, {})).toBe(0);
  });
});
