import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { createMcpServer, type McpServerSpec } from './server.js';

export interface StdioOptions {
  /** Receives transport-level errors. Write to stderr only: stdout carries the protocol. */
  onerror?: (error: Error) => void;
}

/** Serve one local client over the process's stdio. Each call still resolves its own context. */
export function serveMcpOverStdio<Ctx>(spec: McpServerSpec<Ctx>, options: StdioOptions = {}): StdioServerHandle {
  return serveStdio(() => createMcpServer(spec), options.onerror === undefined ? {} : { onerror: options.onerror });
}
