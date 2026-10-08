import type { CallToolResult, McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { toSafeError, type SafeErrorOptions } from './errors.js';
import { DEFAULT_MAX_RESULT_BYTES, errorResult, successResult } from './result.js';
import type { CallInfo } from './context.js';

export interface ToolRuntime<Ctx> extends SafeErrorOptions {
  /** Called for every tool call so rotated credentials and revoked access take effect immediately. */
  resolveContext(call: CallInfo): Ctx | Promise<Ctx>;
  maxResultBytes?: number;
}

/** A registered-by-closure tool. The generic input and output types are erased here, so no casts are needed. */
export interface McpTool<Ctx> {
  readonly name: string;
  register(server: McpServer, runtime: ToolRuntime<Ctx>): void;
}

export interface ToolSpec<TIn extends z.ZodObject, TOut extends z.ZodObject, Ctx> {
  name: string;
  title: string;
  /** Keep this short: it is part of every client's catalog cost. */
  description: string;
  inputSchema: TIn;
  outputSchema: TOut;
  /** Must describe the behavior accurately. `readOnlyHint` is required. */
  annotations: ToolAnnotations & { readOnlyHint: boolean };
  run(input: z.output<TIn>, ctx: Ctx, call: CallInfo): Promise<z.input<TOut>> | z.input<TOut>;
}

interface ErasedRegistration {
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
}

/** The SDK's registration types are conditional on the schema type; widening here keeps the generics out of it. */
function registerErased(
  server: McpServer,
  name: string,
  config: ErasedRegistration,
  handler: (args: unknown, extra: ServerContext) => Promise<CallToolResult>,
): void {
  server.registerTool(name, config, handler);
}

export function defineTool<TIn extends z.ZodObject, TOut extends z.ZodObject, Ctx>(spec: ToolSpec<TIn, TOut, Ctx>): McpTool<Ctx> {
  return {
    name: spec.name,
    register(server, runtime) {
      registerErased(
        server,
        spec.name,
        { title: spec.title, description: spec.description, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema, annotations: spec.annotations },
        async (args, extra) => {
          try {
            const call: CallInfo = { signal: extra.mcpReq.signal, authInfo: extra.http?.authInfo };
            const input = spec.inputSchema.parse(args);
            const ctx = await runtime.resolveContext(call);
            const output = spec.outputSchema.parse(await spec.run(input, ctx, call));
            return successResult(output, runtime.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES);
          } catch (error) {
            return errorResult(toSafeError(error, runtime));
          }
        },
      );
    },
  };
}
