import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fakeConvex, jwt, standardHandlers, writeCredential } from './mcp-helpers';

const root = join(import.meta.dirname, '..');
const bundle = join(root, 'agent/dist/lux.mjs');
let dir: string;

beforeAll(async () => {
  // The same options as `npm run agent:build`, so this test covers the shipped bundle.
  await build({
    entryPoints: [join(root, 'agent/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    outfile: bundle,
    logLevel: 'warning',
  });
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('lux mcp over stdio', () => {
  test('speaks the real protocol, pins the repository binding, and loads the credential on every call', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lux-stdio-'));
    const fake = await fakeConvex(standardHandlers());
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, '.lux.json'), JSON.stringify({ version: 1, instance: fake.url, workspace: 'ws_1', project: 'proj_1' }));
    const first = jwt({ sub: 'first' });
    const credential = await writeCredential(dir, { version: 1, instance: fake.url, token: first });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, 'mcp', '--project-dir', join(repo, 'src')],
      env: { LUX_CREDENTIAL_FILE: credential, LUX_ALLOW_INSECURE_LOOPBACK: '1', PATH: process.env['PATH'] ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['lux_context', 'lux_search', 'lux_get']);
      expect((await client.callTool({ name: 'lux_context', arguments: {} })).structuredContent).toMatchObject({
        kind: 'selection',
        selection: { project: { key: 'LUX' } },
      });
      const second = jwt({ sub: 'second' });
      await writeCredential(dir, { version: 1, instance: fake.url, token: second });
      expect((await client.callTool({ name: 'lux_search', arguments: { query: 'a' } })).structuredContent).toMatchObject({
        tasks: [{ key: 'LUX-1' }, { key: 'LUX-2' }],
      });
      expect(fake.requests.map(r => r.authorization)).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
      expect(fake.requests[1]?.args).toMatchObject({ workspace: 'ws_1', project: 'proj_1' });
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test('uses CLAUDE_PROJECT_DIR, and fails to start on an invalid closest binding instead of falling back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lux-stdio-'));
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.lux.json'), JSON.stringify({ version: 3 }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, 'mcp'],
      env: { CLAUDE_PROJECT_DIR: repo, PATH: process.env['PATH'] ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => undefined);
  });
});
