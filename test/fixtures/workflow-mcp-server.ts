import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'Workflow MCP fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'fetch_issue',
  description: 'Local demonstration tool — returns fixture data, not a real Linear issue.',
  inputSchema: {
    type: 'object',
    $defs: { identifier: { type: 'string', minLength: 1, description: 'Issue identifier, such as LIN-123. Literals and workflow references are supported.' } },
    properties: {
      issueId: { $ref: '#/$defs/identifier' },
      includeRelations: { type: 'boolean', default: true, description: 'Include blocking and related issue references.' },
      detail: { anyOf: [{ const: 'summary', type: 'string' }, { const: 'full', type: 'string' }], default: 'summary', description: 'Choose how much fixture data to return.' },
    },
    required: ['issueId'], additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, exists: { type: 'boolean' } }, required: ['id', 'title', 'exists'], additionalProperties: false },
}] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({
  structuredContent: { id: String(request.params.arguments?.issueId), title: 'Demonstration issue', exists: true },
  content: [{ type: 'text', text: 'Fixture issue fetched directly, without a model.' }],
}));
await server.connect(new StdioServerTransport());
