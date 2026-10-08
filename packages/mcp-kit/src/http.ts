import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { createMcpServer, type McpServerSpec } from './server.js';
import type { CallInfo } from './context.js';

/** A request identity that the host application has already verified. The kit never inspects credentials. */
export interface VerifiedIdentity<Caller> {
  /** Opaque to the kit. It reaches `resolveContext` and nothing else. */
  caller: Caller;
  clientId: string;
  scopes: readonly string[];
  /** Seconds since the epoch. Required: identities that never expire are refused. */
  expiresAt: number;
  /** The resource (audience) issued for the credential. Compare absolute URLs ignoring a fragment and one trailing slash; keep the query. */
  resource: URL | string;
}

/** Throw from `authenticate` for a bad or missing credential. Any other throw is reported as a 500. */
export class AuthenticationFailure extends Error {
  constructor(message = 'Authentication failed.') {
    super(message);
    this.name = 'AuthenticationFailure';
  }
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface StreamableHttpOptions<Caller, Ctx> extends Omit<McpServerSpec<Ctx>, 'resolveContext'> {
  /**
   * Verify the request's credential (signature, issuer, audience, expiry, ...) and return the identity, or
   * `null` to refuse. Called for every request; the kit keeps no session or identity cache.
   */
  authenticate(request: Request): Promise<VerifiedIdentity<Caller> | null | undefined>;
  /** Optional per-request decision after authentication. Returning false answers 403. */
  authorize?(identity: VerifiedIdentity<Caller>, request: Request): boolean | Promise<boolean>;
  resolveContext(caller: Caller, call: CallInfo): Ctx | Promise<Ctx>;
  /** Absolute URL of this MCP endpoint. Resource comparison ignores a fragment and one trailing slash, and preserves the query. */
  resource: URL | string;
  requiredScopes?: readonly string[];
  /** RFC 9728 metadata URL advertised in 401/403 challenges. */
  resourceMetadataUrl?: string;
  /** Hostnames (no port) accepted in the Host header. Required: there is no permissive default. */
  allowedHosts: readonly string[];
  /** Hostnames (no scheme or port) accepted in the Origin header when one is sent. Required. */
  allowedOrigins: readonly string[];
  maxBodyBytes?: number;
  onerror?: (error: Error) => void;
  /** Clock override for tests, in milliseconds. */
  now?: () => number;
}

export interface StreamableHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Compare absolute resource URLs ignoring a fragment and one trailing slash; preserve the query. */
const canonical = (value: URL | string): string | null => {
  try {
    const text = typeof value === 'string' ? new URL(value).href : value.href;
    return text.split('#')[0]?.replace(/\/$/, '') ?? null;
  } catch {
    return null;
  }
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A stateless Streamable HTTP endpoint. Every request is checked for Host, Origin, authentication, expiry,
 * resource and scopes before the body is read, then served by a fresh server instance bound to that
 * request's caller, so concurrent callers share nothing.
 */
export function createStreamableHttpHandler<Caller, Ctx>(options: StreamableHttpOptions<Caller, Ctx>): StreamableHttpHandler {
  if (options.allowedHosts.length === 0) throw new Error('allowedHosts must not be empty.');
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isFinite(maxBody) || maxBody <= 0) throw new Error('maxBodyBytes must be a positive number.');
  const resource = canonical(options.resource);
  if (resource === null) throw new Error('resource must be an absolute URL.');
  const resourceUrl = new URL(resource);
  const requiredScopes = [...(options.requiredScopes ?? [])];
  const challenge = { requiredScopes, ...(options.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: options.resourceMetadataUrl }) };
  const now = options.now ?? Date.now;
  const callers = new WeakMap<AuthInfo, Caller>();

  const handler = createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo === undefined ? undefined : callers.get(authInfo);
      return createMcpServer<Ctx>({
        ...options,
        resolveContext: async call => {
          if (caller === undefined) throw new Error('Request reached a tool without a verified caller.');
          return options.resolveContext(caller, call);
        },
      });
    },
    { legacy: 'stateless', maxRequestBodySize: maxBody, ...(options.onerror === undefined ? {} : { onerror: options.onerror }) },
  );

  async function fetch(request: Request): Promise<Response> {
    const rejected = hostHeaderValidationResponse(request, [...options.allowedHosts]) ?? originValidationResponse(request, [...options.allowedOrigins]);
    if (rejected) return rejected;
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > maxBody) return json(413, { error: 'payload_too_large' });
    let identity: VerifiedIdentity<Caller> | null | undefined;
    try {
      identity = await options.authenticate(request);
    } catch (error) {
      if (error instanceof AuthenticationFailure)
        return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or missing credential.'), challenge);
      // Verifiers can include raw credentials in thrown values. Keep those values out of host logs too.
      options.onerror?.(new Error('Authentication is unavailable.'));
      return bearerAuthChallengeResponse(new Error('Authentication is unavailable.'), challenge);
    }
    const invalid = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or missing credential.'), challenge);
    if (!identity) return invalid;
    if (!Number.isFinite(identity.expiresAt) || identity.expiresAt * 1000 <= now()) return invalid;
    if (canonical(identity.resource) !== resource) return invalid;
    if (!Array.isArray(identity.scopes) || !identity.scopes.every((scope: unknown) => typeof scope === 'string')) return invalid;
    if (!requiredScopes.every(scope => identity.scopes.includes(scope))) {
      return bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InsufficientScope, 'Missing required scope.'), challenge);
    }
    try {
      if (options.authorize && !(await options.authorize(identity, request))) return json(403, { error: 'forbidden' });
    } catch {
      options.onerror?.(new Error('Authorization is unavailable.'));
      return bearerAuthChallengeResponse(new Error('Authorization is unavailable.'), challenge);
    }
    const authInfo: AuthInfo = {
      token: '',
      clientId: identity.clientId,
      scopes: [...identity.scopes],
      expiresAt: identity.expiresAt,
      resource: resourceUrl,
    };
    callers.set(authInfo, identity.caller);
    return handler.fetch(request, { authInfo });
  }

  return { fetch, close: () => handler.close() };
}
