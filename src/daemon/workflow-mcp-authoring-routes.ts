import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkflowMcpAuthoring } from '../protocol/workflow-mcp-authoring.ts';
import { send } from './http.ts';

export async function workflowMcpAuthoringRoutes(request: IncomingMessage, response: ServerResponse, url: string | URL, service?: WorkflowMcpAuthoring): Promise<boolean> {
  const pathname = typeof url === 'string' ? url : url.pathname;
  if (pathname !== '/api/workflow-mcp' && !pathname.startsWith('/api/workflow-mcp/')) return false;
  response.setHeader('cache-control', 'no-store');
  if (!service) { send(response, 404, { error: 'Workflow MCP authoring unavailable' }); return true; }
  if (request.method !== 'GET') { send(response, 405, { error: 'Method not allowed' }); return true; }
  let connectionId: string | undefined, projectId: string | undefined, refresh = false;
  try {
    const match = /^\/api\/workflow-mcp(?:\/([^/]+))?$/.exec(pathname);
    if (!match) throw new Error();
    connectionId = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
    if (connectionId !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(connectionId)) throw new Error();
    const query = (typeof url === 'string' ? new URL(request.url ?? pathname, 'http://localhost') : url).searchParams;
    if ([...query.keys()].some(key => !['projectId', 'refresh'].includes(key)) || query.getAll('projectId').length > 1 || query.getAll('refresh').length > 1) throw new Error();
    if (query.has('refresh') && (query.get('refresh') !== '1' || connectionId === undefined)) throw new Error();
    refresh = query.get('refresh') === '1';
    projectId = query.get('projectId') ?? undefined;
    if (projectId !== undefined && (!projectId.length || projectId.length > 4_096 || projectId.includes('\0'))) throw new Error();
  } catch { send(response, 400, { error: 'Invalid workflow MCP request' }); return true; }
  try {
    send(response, 200, connectionId === undefined ? await service.connections(projectId) : await service.discover(projectId, connectionId, refresh));
  } catch {
    send(response, 400, { error: 'Workflow MCP connection or Scope unavailable. Check MCP Settings and the selected Project.' });
  }
  return true;
}
