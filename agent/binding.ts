import { ToolError, BindingError, discoverBinding, type DeepReadonly, type FoundBinding } from '@reotech/mcp-kit';
import { z } from 'zod';
import { agentWorkspaceSchema } from '../shared/agent';
import { parseInstance } from './config';

export const BINDING_FILE = '.lux.json';

/** Non-secret, versioned repository binding. It selects a destination; it never grants access. */
export function luxBindingSchema(allowLoopbackHttp: boolean) {
  const id = agentWorkspaceSchema.shape.id;
  return z
    .object({
      version: z.literal(1),
      instance: z.string().transform((value, ctx) => {
        try {
          return parseInstance(value, allowLoopbackHttp);
        } catch (error) {
          ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'invalid instance' });
          return z.NEVER;
        }
      }),
      workspace: id,
      project: id,
    })
    .strict();
}

export type LuxBinding = DeepReadonly<z.output<ReturnType<typeof luxBindingSchema>>>;
export type FoundLuxBinding = FoundBinding<z.output<ReturnType<typeof luxBindingSchema>>>;

export function bindingSpec(allowLoopbackHttp: boolean) {
  return { fileName: BINDING_FILE, schema: luxBindingSchema(allowLoopbackHttp) };
}

/** Closest valid binding between `projectDir` and the Git root, or null. An invalid closest file is an error. */
export async function findLuxBinding(projectDir: string, allowLoopbackHttp: boolean): Promise<FoundLuxBinding | null> {
  try {
    return await discoverBinding(projectDir, bindingSpec(allowLoopbackHttp));
  } catch (error) {
    if (error instanceof BindingError) {
      throw new ToolError(error.problem === 'BINDING_INVALID' ? 'BINDING_INVALID' : 'PROJECT_DIR_INVALID', error.message, {
        hint:
          error.problem === 'BINDING_INVALID'
            ? 'Fix or delete the file, or re-run `lux link`. Lux does not fall back to another workspace.'
            : 'Pass --project-dir with an existing directory inside the repository.',
      });
    }
    throw error;
  }
}

export interface ScopeInput {
  workspace?: string | undefined;
  project?: string | undefined;
}

/**
 * Fill a request's workspace and project from the pinned binding. Explicit values are accepted because the
 * backend authorizes every call; a project is only inherited together with the binding's own workspace, so a
 * request can never combine one workspace's ID with another's project. The instance is never overridable here.
 */
export function applyBinding(input: ScopeInput, binding: LuxBinding | null): ScopeInput {
  if (!binding) return { workspace: input.workspace, project: input.project };
  const workspace = input.workspace ?? binding.workspace;
  const project = input.project ?? (workspace === binding.workspace ? binding.project : undefined);
  return { workspace, project };
}
