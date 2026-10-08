import type { CallToolResult } from '@modelcontextprotocol/server';
import { ToolError, type SafeError } from './errors.js';

/** Serialized size limit for structured data. The compact text copy roughly doubles what a host may inject. */
export const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;

/**
 * Build a tool result carrying validated structured data plus a compact JSON text block for clients that only
 * read `content`. Oversized data is refused; it is never silently truncated.
 */
export function successResult(data: Record<string, unknown>, maxBytes: number = DEFAULT_MAX_RESULT_BYTES): CallToolResult {
  const text = JSON.stringify(data);
  const size = Buffer.byteLength(text);
  if (size > maxBytes) {
    throw new ToolError('OUTPUT_TOO_LARGE', `The result is ${size} bytes, over the ${maxBytes}-byte limit.`, {
      hint: 'Narrow the request: use a smaller limit or more specific filters.',
    });
  }
  return { content: [{ type: 'text', text }], structuredContent: data };
}

export function errorResult(error: SafeError): CallToolResult {
  const hint = error.hint === undefined ? '' : ` Next: ${error.hint}`;
  return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}${hint}` }] };
}
