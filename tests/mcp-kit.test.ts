import { createServer, type Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  AuthenticationFailure,
  ToolError,
  createMcpServer,
  createStreamableHttpHandler,
  defineTool,
  redactSecrets,
  type VerifiedIdentity,
} from '@reotech/mcp-kit';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Ctx {
  who: string;
}
const SECRET = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.signature-value';

function tools() {
  const echo = defineTool({
    name: 'echo',
    title: 'Echo',
    description: 'Return who is calling and the text.',
    inputSchema: z.object({ text: z.string().max(20) }).strict(),
    outputSchema: z.object({ who: z.string(), text: z.string() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (input, ctx: Ctx) => ({ who: ctx.who, text: input.text }),
  });
  const big = defineTool({
    name: 'big',
    title: 'Big',
    description: 'Return a result over budget.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ blob: z.string() }).strict(),
    annotations: { readOnlyHint: true },
    run: () => ({ blob: 'x'.repeat(5000) }),
  });
  const failing = defineTool({
    name: 'failing',
    title: 'Failing',
    description: 'Throw different errors.',
    inputSchema: z.object({ mode: z.enum(['expected', 'unexpected', 'shape']) }).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    annotations: { readOnlyHint: true },
    run: input => {
      if (input.mode === 'expected') throw new ToolError('NOPE', `Cannot do it with ${SECRET}`, { hint: 'Try later.', retryable: true });
      if (input.mode === 'unexpected') throw new Error(`upstream said Bearer ${SECRET} at https://user:pw@internal.example/db`);
      return JSON.parse('{"ok":"yes"}');
    },
  });
  return [echo, big, failing];
}

async function inMemory(who = 'local') {
  const logs: string[] = [];
  const server = createMcpServer<Ctx>({
    name: 'fixture',
    version: '1.0.0',
    instructions: 'Fixture.',
    tools: tools(),
    maxResultBytes: 2000,
    resolveContext: () => ({ who }),
    onInternalError: (ref, text) => logs.push(`${ref} ${text}`),
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, logs };
}

describe('mcp-kit over an in-memory transport', () => {
  test('initializes, lists a stable catalog with accurate annotations and output schemas, and calls a tool', async () => {
    const { client } = await inMemory('alice');
    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name)).toEqual(['echo', 'big', 'failing']);
    expect(listed.tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(listed.tools[0]?.outputSchema).toMatchObject({ type: 'object' });
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(result.structuredContent).toEqual({ who: 'alice', text: 'hi' });
    expect(result.content).toEqual([{ type: 'text', text: '{"who":"alice","text":"hi"}' }]);
  });

  test('rejects invalid input without running the tool', async () => {
    const { client } = await inMemory();
    for (const args of [{ text: 'x'.repeat(21) }, { text: 'a', extra: 1 }, {}]) {
      const result = await client.callTool({ name: 'echo', arguments: args }).catch((error: unknown) => ({ isError: true, thrown: String(error) }));
      expect(result).toMatchObject({ isError: true });
    }
  });

  test('refuses an over-budget result instead of truncating it', async () => {
    const { client } = await inMemory();
    const result = await client.callTool({ name: 'big', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('OUTPUT_TOO_LARGE');
    expect(JSON.stringify(result.content)).not.toContain('xxxxx');
  });

  test('returns actionable errors without secrets and hides unexpected failure details', async () => {
    const { client, logs } = await inMemory();
    const expected = await client.callTool({ name: 'failing', arguments: { mode: 'expected' } });
    expect(expected.isError).toBe(true);
    const text = JSON.stringify(expected.content);
    expect(text).toContain('NOPE');
    expect(text).toContain('Try later.');
    expect(text).not.toContain(SECRET);
    for (const mode of ['unexpected', 'shape']) {
      const result = await client.callTool({ name: 'failing', arguments: { mode } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('INTERNAL');
      expect(JSON.stringify(result)).not.toMatch(/internal\.example|user:pw|signature-value/);
    }
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).not.toMatch(/signature-value|user:pw/);
  });
});

describe('redactSecrets', () => {
  test('removes JWTs, bearer values, key assignments, URL credentials and literal secrets', () => {
    const text = redactSecrets(`a ${SECRET} b Bearer abcdef123456 c token=hunter2hunter2 d https://u:p@host/x e my-literal-secret-value`, [
      'my-literal-secret-value',
    ]);
    expect(text).not.toMatch(/signature-value|abcdef123456|hunter2|u:p@|my-literal/);
    expect(text).toContain('https://[redacted]@host/x');
  });
});

// A verified-identity fixture: `Bearer fixture:<json>`. The kit verifies none of it; this stands in for a host's verifier.
const RESOURCE = 'https://mcp.example.test/mcp';
const token = (name: string, claims: { ttl?: number | string; resource?: string; scopes?: string[] } = {}) => `fixture:${JSON.stringify({ name, ...claims })}`;
const fixtureClaims = z.object({
  name: z.string(),
  ttl: z.union([z.number(), z.string()]).default(300),
  resource: z.string().default(RESOURCE),
  scopes: z.array(z.string()).default(['read']),
});
function fixtureAuth(now: () => number) {
  return async (request: Request): Promise<VerifiedIdentity<{ name: string }> | null> => {
    const header = request.headers.get('authorization');
    if (!header) return null;
    if (!header.startsWith('Bearer fixture:')) throw new AuthenticationFailure();
    const claims = fixtureClaims.parse(JSON.parse(header.slice('Bearer fixture:'.length)));
    return {
      caller: { name: claims.name },
      clientId: 'fixture-client',
      scopes: claims.scopes,
      expiresAt: Math.floor(now() / 1000) + Number(claims.ttl),
      resource: claims.resource,
    };
  };
}

async function httpFixture(overrides: Partial<Parameters<typeof createStreamableHttpHandler<{ name: string }, Ctx>>[0]> = {}) {
  const now = () => Date.now();
  const handler = createStreamableHttpHandler<{ name: string }, Ctx>({
    name: 'fixture',
    version: '1.0.0',
    tools: tools(),
    resolveContext: caller => ({ who: caller.name }),
    authenticate: fixtureAuth(now),
    resource: RESOURCE,
    requiredScopes: ['read'],
    resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['127.0.0.1'],
    maxBodyBytes: 4096,
    ...overrides,
  });
  const nodeHandler = toNodeHandler(handler);
  const http: Server = createServer((req, res) => void nodeHandler(req, res));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  cleanups.push(async () => {
    await handler.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const connect = async (bearer: string) => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
    cleanups.push(() => client.close());
    return client;
  };
  const post = (headers: Record<string, string>, body: string) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body });
  return { url, connect, post };
}
const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});

describe('mcp-kit stateless Streamable HTTP', () => {
  test('serves the SDK client: initialize, list and call as the verified caller', async () => {
    const { connect } = await httpFixture();
    const client = await connect(token('alice'));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['echo', 'big', 'failing']);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    expect(result.structuredContent).toEqual({ who: 'alice', text: 'hello' });
  });

  test('keeps simultaneous callers isolated', async () => {
    const { connect } = await httpFixture();
    const [alice, bob] = await Promise.all([connect(token('alice')), connect(token('bob'))]);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => [alice, bob][i % 2]?.callTool({ name: 'echo', arguments: { text: String(i) } })));
    expect(results.map(r => r?.structuredContent)).toEqual(Array.from({ length: 8 }, (_, i) => ({ who: i % 2 ? 'bob' : 'alice', text: String(i) })));
  });

  test.each([
    ['missing credential', {}, 401],
    ['malformed credential', { authorization: 'Bearer nonsense' }, 401],
    ['expired identity', { authorization: `Bearer ${token('alice', { ttl: -5 })}` }, 401],
    ['identity without a usable expiry', { authorization: `Bearer ${token('alice', { ttl: 'soon' })}` }, 401],
    ['wrong resource', { authorization: `Bearer ${token('alice', { resource: 'https://other.example.test/mcp' })}` }, 401],
    ['unparseable resource', { authorization: `Bearer ${token('alice', { resource: 'not a url' })}` }, 401],
    ['missing scope', { authorization: `Bearer ${token('alice', { scopes: ['other'] })}` }, 403],
  ])('refuses a %s before any tool runs', async (_name, headers, status) => {
    const { post } = await httpFixture();
    const response = await post({ host: '127.0.0.1', ...headers }, initialize);
    expect(response.status).toBe(status);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
    expect(await response.text()).not.toContain('alice');
  });

  test('rejects an untrusted Origin and an oversized body, and reports verifier outages as 500', async () => {
    const { post, url } = await httpFixture();
    const headers = { authorization: `Bearer ${token('alice')}` };
    expect((await post({ ...headers, origin: 'https://evil.example' }, initialize)).status).toBe(403);
    expect((await post(headers, 'x'.repeat(5000))).status).toBe(413);
    // A chunked body has no Content-Length to check up front; the reader still enforces the bound.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2500)));
        controller.enqueue(new TextEncoder().encode('x'.repeat(2500)));
        controller.close();
      },
    });
    const init = {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: chunked,
      duplex: 'half',
    };
    const streamed = await fetch(url, init);
    expect(streamed.status).toBe(413);
    const unavailable = await httpFixture({
      authenticate: () => {
        throw new Error('jwks fetch failed');
      },
    });
    const response = await unavailable.post({}, initialize);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('jwks');
  });

  test('refuses an unlisted Host header', async () => {
    const { url } = await httpFixture({ allowedHosts: ['mcp.example.test'] });
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token('alice')}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: initialize,
    });
    expect(response.status).toBe(403);
  });

  test('lets the host deny after authentication and requires a host allowlist', async () => {
    const { post } = await httpFixture({ authorize: identity => identity.caller.name !== 'mallory' });
    expect((await post({ authorization: `Bearer ${token('mallory')}` }, initialize)).status).toBe(403);
    expect((await post({ authorization: `Bearer ${token('alice')}` }, initialize)).status).toBe(200);
    expect(() =>
      createStreamableHttpHandler<{ name: string }, Ctx>({
        name: 'x',
        version: '1',
        tools: [],
        resolveContext: () => ({ who: '' }),
        authenticate: async () => null,
        resource: RESOURCE,
        allowedHosts: [],
        allowedOrigins: [],
      }),
    ).toThrow();
  });

  test.each([null, 'read', ['read', 1]])('refuses malformed runtime scopes %j as an invalid identity', async scopes => {
    const identity: VerifiedIdentity<{ name: string }> = {
      caller: { name: 'alice' },
      clientId: 'fixture',
      scopes: ['read'],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      resource: RESOURCE,
    };
    // Host verifier implementations can return malformed values despite their declared interface.
    Object.defineProperty(identity, 'scopes', { value: scopes });
    const { post } = await httpFixture({ authenticate: async () => identity });
    expect((await post({}, initialize)).status).toBe(401);
  });

  test.each(['authenticate', 'authorize'] as const)('contains %s failures and reports one safe callback error', async stage => {
    const errors: Error[] = [];
    const fail = async () => {
      throw new Error(`credential ${SECRET} and opaque-secret-value`);
    };
    const { post } = await httpFixture({
      [stage]: fail,
      onerror: error => errors.push(error),
    });
    const response = await post({ authorization: `Bearer ${token('alice')}` }, initialize);
    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(stage === 'authenticate' ? 'Authentication is unavailable.' : 'Authorization is unavailable.');
    expect(`${await response.text()} ${errors.map(error => error.stack).join(' ')}`).not.toMatch(/signature-value|opaque-secret-value/);
  });

  test.each([
    [`${RESOURCE}/`, 200],
    [`${RESOURCE}#fragment`, 200],
    [`${RESOURCE}?variant=other`, 401],
  ])('compares resource %s with the documented URL policy', async (resource, status) => {
    const { post } = await httpFixture();
    expect((await post({ authorization: `Bearer ${token('alice', { resource })}` }, initialize)).status).toBe(status);
  });
});
