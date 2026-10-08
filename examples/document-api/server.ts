import { createMcpServer, defineTool, ToolError } from '@reotech/mcp-kit';
import { createReadinessReader, readinessInputSchema, readinessOutputSchema, type DocumentOptions } from './readiness.js';

/** Example-only factory. The operator owns transport, destination and automation identity. */
export function createDocumentServer(options: DocumentOptions) {
  const readReadiness = createReadinessReader(options);
  const readiness = defineTool({
    name: 'document_country_pack_readiness',
    title: 'Country pack readiness',
    description: 'Read country pack readiness, blockers and bounded source summaries from the configured Document API.',
    inputSchema: readinessInputSchema,
    outputSchema: readinessOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run(input) {
      try {
        return await readReadiness(input);
      } catch {
        throw new ToolError('DOCUMENT_READINESS_FAILED', 'Document API readiness could not be read.', {
          hint: 'Check the configured Document API origin, automation credential and country pack identity.',
        });
      }
    },
  });
  return createMcpServer({
    name: 'document-api-example',
    version: '0.1.0',
    instructions: 'Read-only Document API example using an operator-configured automation identity.',
    tools: [readiness],
    resolveContext: () => undefined,
  });
}
