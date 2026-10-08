import { randomUUID } from 'node:crypto';

export interface ToolErrorOptions {
  /** One actionable next step for the caller. Must not contain secrets. */
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
}

/** An expected failure whose message and hint are written for the caller and are safe to return. */
export class ToolError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly retryable: boolean;
  constructor(code: string, message: string, options: ToolErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolError';
    this.code = code;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
  }
}

export interface SafeError {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

const REDACTED = '[redacted]';
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEYED_SECRET = /\b(token|secret|password|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/** Best-effort removal of credentials from text that may leave the process. Literal secrets are removed first. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  out = out.replace(JWT, REDACTED);
  out = out.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(KEYED_SECRET, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  out = out.replace(URL_CREDENTIALS, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  return out;
}

export interface SafeErrorOptions {
  /** Literal values (for example the current token) that must never appear in output or logs. */
  secrets?: () => readonly string[];
  /** Receives a redacted description of an unexpected failure, keyed by the reference shown to the caller. */
  onInternalError?: (reference: string, description: string) => void;
}

/**
 * Convert any thrown value into a result safe to return to an MCP client. Only `ToolError` text reaches the
 * caller; anything else is reduced to a generic message with a reference for operators.
 */
export function toSafeError(error: unknown, options: SafeErrorOptions = {}): SafeError {
  const secrets = options.secrets?.() ?? [];
  if (error instanceof ToolError) {
    return {
      code: error.code,
      message: redactSecrets(error.message, secrets),
      ...(error.hint === undefined ? {} : { hint: redactSecrets(error.hint, secrets) }),
      retryable: error.retryable,
    };
  }
  const reference = randomUUID().slice(0, 8);
  const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  options.onInternalError?.(reference, redactSecrets(description, secrets));
  return {
    code: 'INTERNAL',
    message: `Unexpected server error (reference ${reference}).`,
    hint: 'Retry once. If it persists, report the reference to the operator.',
    retryable: true,
  };
}
