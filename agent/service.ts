import { ToolError } from '@reotech/mcp-kit';
import type { z } from 'zod';
import {
  agentContextRequestSchema,
  agentContextResponseSchema,
  agentGetRequestSchema,
  agentGetResponseSchema,
  agentSearchRequestSchema,
  agentSearchResponseSchema,
  type AgentContextResponse,
  type AgentGetResponse,
  type AgentSearchResponse,
} from '../shared/agent';
import { applyBinding, type LuxBinding } from './binding';
import type { BackendFactory } from './backend';
import { loadCredential, type LuxCredential } from './credentials';

/** The three read operations, independent of MCP or CLI. Every call re-reads the credential and re-checks the destination. */
export interface AgentService {
  readonly binding: LuxBinding | null;
  context(input: RawRequest, signal?: AbortSignal): Promise<AgentContextResponse>;
  search(input: RawRequest, signal?: AbortSignal): Promise<AgentSearchResponse>;
  get(input: RawRequest, signal?: AbortSignal): Promise<AgentGetResponse>;
}

/** Unvalidated caller input (CLI flags or tool arguments). The service validates it with the shared schemas. */
export interface RawRequest {
  workspace?: string | undefined;
  project?: string | undefined;
  cursor?: string | undefined;
  [field: string]: unknown;
}

export interface AgentServiceOptions {
  binding: LuxBinding | null;
  credentialFile: string | undefined;
  allowLoopbackHttp: boolean;
  backend: BackendFactory;
  now?: () => number;
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 5).map(issue => `${issue.path.join('.') || '(request)'}: ${issue.message}`);
  throw new ToolError(what === 'request' ? 'INVALID_INPUT' : 'BACKEND_RESPONSE_INVALID', `Invalid ${what}: ${issues.join('; ')}`, {
    hint: what === 'request' ? 'Correct the arguments and retry.' : 'The Lux backend returned an unexpected shape; update the connector.',
  });
}

const contextRequired = (what: string) =>
  new ToolError('CONTEXT_REQUIRED', `${what} requires a workspace and project, and no repository binding supplies them.`, {
    hint: 'Run `lux link` in the repository, or pass workspace and project IDs (list them with lux_context).',
  });

export function createAgentService(options: AgentServiceOptions): AgentService {
  const { binding } = options;

  async function connect(): Promise<LuxCredential> {
    const credential = await loadCredential(options.credentialFile, {
      allowLoopbackHttp: options.allowLoopbackHttp,
      ...(options.now ? { now: options.now } : {}),
    });
    // The checked-in binding must never choose where the user's token goes.
    if (binding && binding.instance !== credential.instance) {
      throw new ToolError('INSTANCE_MISMATCH', 'The repository binding names a different Lux instance than the configured credential. No request was sent.', {
        hint: "Use a credential for the binding's instance, or correct .lux.json if you trust the change.",
      });
    }
    return credential;
  }

  return {
    binding,
    async context(input, signal) {
      const bare = input.workspace === undefined && input.project === undefined && input.cursor === undefined;
      const scope = binding && bare ? { workspace: binding.workspace, project: binding.project } : { workspace: input.workspace, project: input.project };
      const request = parse(agentContextRequestSchema, { ...input, ...scope }, 'request');
      const credential = await connect();
      const response = parse(agentContextResponseSchema, await options.backend(credential.instance, credential.token, signal).context(request), 'response');
      if (response.kind === 'selection' && (response.selection.workspace.id !== request.workspace || response.selection.project.id !== request.project)) {
        throw new ToolError('BACKEND_RESPONSE_INVALID', 'The backend returned a different selection than requested.');
      }
      return response;
    },
    async search(input, signal) {
      const scope = applyBinding(input, binding);
      if (!scope.workspace || !scope.project) throw contextRequired('Searching tasks');
      const request = parse(agentSearchRequestSchema, { ...input, ...scope }, 'request');
      const credential = await connect();
      return parse(agentSearchResponseSchema, await options.backend(credential.instance, credential.token, signal).search(request), 'response');
    },
    async get(input, signal) {
      const scope = applyBinding(input, binding);
      if (!scope.workspace || !scope.project) throw contextRequired('Fetching a task');
      const request = parse(agentGetRequestSchema, { ...input, ...scope }, 'request');
      const credential = await connect();
      return parse(agentGetResponseSchema, await options.backend(credential.instance, credential.token, signal).get(request), 'response');
    },
  };
}
