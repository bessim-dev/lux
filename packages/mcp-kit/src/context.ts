import type { AuthInfo } from '@modelcontextprotocol/server';

/** What the transport knows about one tool call. Stdio never has `authInfo`; HTTP always does. */
export interface CallInfo {
  signal: AbortSignal;
  authInfo?: AuthInfo | undefined;
}
