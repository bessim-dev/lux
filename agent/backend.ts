import { ToolError } from '@reotech/mcp-kit';
import { ConvexError } from 'convex/values';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { AgentContextRequest, AgentGetRequest, AgentSearchRequest } from '../shared/agent';

/** Raw backend access. Responses are untrusted until the service validates them with the shared schemas. */
export interface AgentBackend {
  context(request: AgentContextRequest): Promise<unknown>;
  search(request: AgentSearchRequest): Promise<unknown>;
  get(request: AgentGetRequest): Promise<unknown>;
}

/** Called once per request with the destination and token. Implementations must not retain either. */
export type BackendFactory = (instance: string, token: string, signal?: AbortSignal) => AgentBackend;

export const UPSTREAM_TIMEOUT_MS = 15_000;

// Typed references to convex/agent.ts, independent of generated code.
const contextRef = makeFunctionReference<'query', AgentContextRequest, unknown>('agent:context');
const searchRef = makeFunctionReference<'query', AgentSearchRequest, unknown>('agent:search');
const getRef = makeFunctionReference<'query', AgentGetRequest, unknown>('agent:get');

function translate(error: unknown): ToolError {
  if (error instanceof ConvexError && typeof error.data === 'string') {
    const match = /^([A-Z][A-Z0-9_]+): ([^]*)$/.exec(error.data);
    if (match?.[1]) return new ToolError(match[1], (match[2] ?? '').slice(0, 300));
    return new ToolError('REQUEST_REJECTED', error.data.slice(0, 300), { hint: 'Check the workspace and project IDs and your access.' });
  }
  return new ToolError('UPSTREAM_UNAVAILABLE', 'The Lux backend request failed.', {
    retryable: true,
    hint: 'Check the network and that the credential has not expired or been revoked, then retry.',
  });
}

/** A new HTTP client per call, so no identity or cache is shared between callers. */
export const convexBackend: BackendFactory = (instance, token, signal) => {
  const run = async <T>(call: (client: ConvexHttpClient) => Promise<T>): Promise<T> => {
    const deadline = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const client = new ConvexHttpClient(instance, {
      skipConvexDeploymentUrlCheck: true,
      logger: false,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          signal: init?.signal ? AbortSignal.any([requestSignal, init.signal]) : requestSignal,
        }),
    });
    client.setAuth(token);
    try {
      return await call(client);
    } catch (error) {
      if (signal?.aborted) throw new ToolError('REQUEST_CANCELLED', 'The Lux backend request was cancelled.');
      if (deadline.aborted)
        throw new ToolError('UPSTREAM_TIMEOUT', 'The Lux backend did not respond within 15 seconds.', {
          retryable: true,
          hint: 'Check the connection and retry.',
        });
      throw translate(error);
    }
  };
  return {
    context: request => run(client => client.query(contextRef, request)),
    search: request => run(client => client.query(searchRef, request)),
    get: request => run(client => client.query(getRef, request)),
  };
};
