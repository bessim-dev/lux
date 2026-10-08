import { McpServer } from '@modelcontextprotocol/server';
import type { SafeErrorOptions } from './errors.js';
import type { CallInfo } from './context.js';
import type { McpTool } from './tool.js';

export interface McpServerSpec<Ctx> extends SafeErrorOptions {
  name: string;
  version: string;
  title?: string;
  /** Keep this short; every connected client receives it. */
  instructions?: string;
  tools: readonly McpTool<Ctx>[];
  /** Builds the per-call context (credentials, pinned scope). Runs inside the tool-call error boundary. */
  resolveContext(call: CallInfo): Ctx | Promise<Ctx>;
  maxResultBytes?: number;
}

/** Create one server instance. Tool order is the order given, so the catalog is stable. */
export function createMcpServer<Ctx>(spec: McpServerSpec<Ctx>): McpServer {
  const names = new Set<string>();
  for (const tool of spec.tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
  const server = new McpServer(
    { name: spec.name, version: spec.version, ...(spec.title === undefined ? {} : { title: spec.title }) },
    spec.instructions === undefined ? {} : { instructions: spec.instructions },
  );
  for (const tool of spec.tools) tool.register(server, spec);
  return server;
}
