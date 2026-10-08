import { ToolError, parseServiceOrigin } from '@reotech/mcp-kit';

/** Environment variables read by the Lux connector. Nothing here is a secret except the file the first one names. */
export const ENV_CREDENTIAL_FILE = 'LUX_CREDENTIAL_FILE';
export const ENV_ALLOW_LOOPBACK_HTTP = 'LUX_ALLOW_INSECURE_LOOPBACK';

export interface LuxEnvironment {
  credentialFile: string | undefined;
  allowLoopbackHttp: boolean;
  claudeProjectDir: string | undefined;
}

export function readEnvironment(env: Readonly<Record<string, string | undefined>>): LuxEnvironment {
  return {
    credentialFile: env[ENV_CREDENTIAL_FILE] || undefined,
    allowLoopbackHttp: env[ENV_ALLOW_LOOPBACK_HTTP] === '1',
    claudeProjectDir: env['CLAUDE_PROJECT_DIR'] || undefined,
  };
}

/** Normalize a Lux instance origin or throw a caller-safe error. */
export function parseInstance(raw: string, allowLoopbackHttp: boolean): string {
  try {
    return parseServiceOrigin(raw, { allowLoopbackHttp });
  } catch (error) {
    throw new ToolError('INSTANCE_INVALID', error instanceof Error ? error.message : 'Invalid Lux instance URL.', {
      hint: `Use the https Convex deployment URL. Plain http to 127.0.0.1 needs ${ENV_ALLOW_LOOPBACK_HTTP}=1 and is for local tests only.`,
    });
  }
}
