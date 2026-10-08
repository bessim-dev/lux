import { PrivateFileError, ToolError, readPrivateFile } from '@reotech/mcp-kit';
import { z } from 'zod';
import { ENV_CREDENTIAL_FILE, parseInstance } from './config';

export interface LuxCredential {
  readonly instance: string;
  readonly token: string;
}

const credentialFileSchema = z.object({ version: z.literal(1), instance: z.string().min(1).max(300), token: z.string().min(20).max(8192) }).strict();

const renewHint = 'Renew the token (manual in this release, see docs/mcp-setup.md) and rewrite the credential file with mode 600.';

function claims(token: string): { exp: number; aud: readonly string[] } {
  const parts = token.split('.');
  const bad = () =>
    new ToolError('AUTH_INVALID', 'The credential is not a JWT.', {
      hint: 'Store the short-lived Clerk JWT for the "convex" audience in the credential file.',
    });
  if (parts.length !== 3 || !parts[1]) throw bad();
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const parsed = z.object({ exp: z.number(), aud: z.union([z.string(), z.array(z.string())]) }).safeParse(payload);
    if (!parsed.success) throw bad();
    return { exp: parsed.data.exp, aud: typeof parsed.data.aud === 'string' ? [parsed.data.aud] : parsed.data.aud };
  } catch (error) {
    throw error instanceof ToolError ? error : bad();
  }
}

export interface LoadCredentialOptions {
  allowLoopbackHttp: boolean;
  now?: () => number;
}

/**
 * Read the credential file on every call, so a rotated token is picked up without a restart. The token is
 * checked locally for expiry and the `convex` audience (a convenience only: Convex verifies the signature and
 * decides access). The file must be private, owned by the current user, and not a symlink.
 */
export async function loadCredential(path: string | undefined, options: LoadCredentialOptions): Promise<LuxCredential> {
  if (!path) {
    throw new ToolError('AUTH_REQUIRED', `No credential file is configured (${ENV_CREDENTIAL_FILE} is unset).`, {
      hint: 'Set it to the path of a private credential file; see docs/mcp-setup.md.',
    });
  }
  let text: string;
  try {
    text = await readPrivateFile(path);
  } catch (error) {
    if (error instanceof PrivateFileError) {
      throw new ToolError(error.problem === 'MISSING' ? 'AUTH_REQUIRED' : 'AUTH_FILE_UNSAFE', error.message, {
        hint:
          error.problem === 'MISSING'
            ? 'Create the credential file; see docs/mcp-setup.md.'
            : 'Fix the file so it is a regular file you own, readable only by you.',
      });
    }
    throw error;
  }
  let parsed: z.output<typeof credentialFileSchema>;
  try {
    parsed = credentialFileSchema.parse(JSON.parse(text));
  } catch {
    // The parse error is withheld: it could quote file contents.
    throw new ToolError('AUTH_INVALID', 'The credential file is malformed.', { hint: 'Expected {"version":1,"instance":"https://…","token":"…"}.' });
  }
  const { exp, aud } = claims(parsed.token);
  if (!aud.includes('convex')) {
    throw new ToolError('AUTH_INVALID', 'The token is not for the "convex" audience.', {
      hint: "Use the user's native Clerk JWT for Convex. An MCP OAuth access token is not accepted.",
    });
  }
  const nowMs = (options.now ?? Date.now)();
  if (exp * 1000 <= nowMs) {
    throw new ToolError('AUTH_EXPIRED', `The token expired at ${new Date(exp * 1000).toISOString()}.`, { hint: renewHint });
  }
  return { instance: parseInstance(parsed.instance, options.allowLoopbackHttp), token: parsed.token };
}
