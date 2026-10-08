import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createDocumentServer } from '../examples/document-api/server';
import { createReadinessReader } from '../examples/document-api/readiness';

// Contract fixture from document-api src/routes/knowledge.ts:61-81 and
// src/features/country-packs/readiness.ts:evaluateCountryPackReadiness.
const source = {
  sourceKey: 'tax-code',
  state: 'MISSING',
  documentId: null,
  currentVersionId: null,
  checksumSha256: null,
  verificationId: null,
  reviewerId: null,
  reviewedAt: null,
};
const readiness = {
  jurisdiction: 'TN',
  version: '2026.1',
  ready: false,
  blockerCodes: ['REQUIRED_LEGAL_SOURCE_MISSING'],
  sources: [source],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        http.close(error => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

async function connect(applicationUrl: string, getApiKey: () => string | Promise<string> = () => 'fixture-private-key') {
  const server = createDocumentServer({ applicationUrl, allowLoopbackHttp: true, getApiKey });
  const client = new Client({ name: 'document-fixture-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const call = (client: Client, args: Record<string, unknown> = { jurisdiction: 'TN', version: '2026.1' }) =>
  client.callTool({ name: 'document_country_pack_readiness', arguments: args });

describe('document API reuse adapter', () => {
  test('initializes, lists one read-only tool, and calls the configured real route with rotating automation credentials', async () => {
    const requests: { url: string | undefined; key: string | string[] | undefined; auth: string | undefined }[] = [];
    const url = await fixture((req, res) => {
      requests.push({ url: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(readiness));
    });
    let key = 'fixture-private-key';
    const client = await connect(url, () => key);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toEqual(['document_country_pack_readiness']);
    expect(listed.tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(JSON.stringify(listed)).not.toContain('applicationUrl');
    const result = await call(client);
    expect(result).toMatchObject({
      structuredContent: {
        ...readiness,
        sources: [{ sourceKey: 'tax-code', state: 'MISSING' }],
        sourceCounts: { MISSING: 1, IDENTITY_MISMATCH: 0, UNVERIFIED: 0, APPROVED: 0 },
        omission: { totalSources: 1, omittedSources: 0, continuation: null },
      },
    });
    key = 'rotated-private-key';
    await call(client);
    expect(requests).toEqual([
      { url: '/v1/knowledge/country-packs/TN/2026.1/readiness', key: 'fixture-private-key', auth: undefined },
      { url: '/v1/knowledge/country-packs/TN/2026.1/readiness', key: 'rotated-private-key', auth: undefined },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-key');
  });

  test('rejects invalid inputs and caller-controlled destinations without making upstream requests', async () => {
    let requests = 0;
    const url = await fixture((_req, res) => {
      requests += 1;
      res.end(JSON.stringify(readiness));
    });
    const client = await connect(url);
    for (const args of [
      { jurisdiction: '../TN', version: '2026.1' },
      { jurisdiction: 'tn', version: '2026.1' },
      { jurisdiction: 'TN', version: 'x'.repeat(33) },
      { jurisdiction: 'TN', version: '../secret' },
      { jurisdiction: 'TN', version: '.' },
      { jurisdiction: 'TN', version: '..' },
      { jurisdiction: 'TN', version: '2026.1', applicationUrl: 'https://attacker.invalid' },
      { jurisdiction: 'TN', version: '2026.1', tenant: 'other', headers: { 'x-api-key': 'attacker' } },
    ])
      expect(await call(client, args)).toMatchObject({ isError: true });
    expect(requests).toBe(0);
  });

  test.each([401, 403, 302])('returns a safe error for HTTP %s and never follows a redirect', async status => {
    let redirected = 0;
    const target = await fixture((_req, res) => {
      redirected += 1;
      res.end('{}');
    });
    const url = await fixture((_req, res) => {
      res.writeHead(status, { location: target });
      res.end('fixture-private-key backend details');
    });
    const result = await call(await connect(url));
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain('fixture-private-key');
    expect(JSON.stringify(result)).not.toContain('backend details');
    expect(redirected).toBe(0);
  });

  test.each([
    'not JSON fixture-private-key',
    JSON.stringify({ ...readiness, ready: 'yes' }),
    JSON.stringify({ ...readiness, jurisdiction: 'FR' }),
    JSON.stringify({ ...readiness, sources: [{ ...source, state: 'NEW_STATE' }] }),
    ' '.repeat(131_073),
  ])('rejects malformed, mismatched or oversized upstream output safely', async body => {
    const url = await fixture((_req, res) => res.end(body));
    const result = await call(await connect(url));
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain('fixture-private-key');
  });

  test('keeps credential-provider failures private and does not fetch', async () => {
    let requests = 0;
    const url = await fixture((_req, res) => {
      requests += 1;
      res.end('{}');
    });
    const client = await connect(url, () => {
      throw new Error('fixture-private-key');
    });
    const result = await call(client);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain('fixture-private-key');
    expect(requests).toBe(0);
  });

  test('summarizes all sources while explicitly bounding returned details', async () => {
    const url = await fixture((_req, res) =>
      res.end(
        JSON.stringify({
          ...readiness,
          sources: Array.from({ length: 25 }, (_, i) => ({ ...source, sourceKey: `source-${i}` })),
        }),
      ),
    );
    const result = await call(await connect(url));
    expect(result).toMatchObject({
      structuredContent: {
        sourceCounts: { MISSING: 25 },
        omission: { totalSources: 25, omittedSources: 5, continuation: null },
      },
    });
    expect(z.object({ sources: z.array(z.unknown()) }).parse(result.structuredContent).sources).toHaveLength(20);
  });

  test('rejects unsafe operator URL configurations before creating a server', () => {
    for (const applicationUrl of [
      'http://example.com',
      'https://user:password@example.com',
      'https://example.com?key=secret',
      'https://example.com#secret',
      'https://example.com?',
      'https://example.com#',
      'https://example.com/path',
      'http://127.0.0.1',
    ])
      expect(() => createReadinessReader({ applicationUrl, getApiKey: () => 'unused' })).toThrow();
  });
});
