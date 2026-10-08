import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CreateWorkflowBuilder } from '../protocol/workflow-builder.ts';
import { readBody, send } from './http.ts';
import { WorkflowBuilderRequestError, type WorkflowBuilderService } from './workflow-builder.ts';

/** Called behind the server's normal authentication and same-origin gate. */
export async function workflowBuilderRoutes(request: IncomingMessage, response: ServerResponse, pathname: string, service?: WorkflowBuilderService): Promise<boolean> {
  if (pathname !== '/api/workflow-builders' && !pathname.startsWith('/api/workflow-builders/')) return false;
  if (!service) { send(response, 404, { error: 'Workflow builder unavailable' }); return true; }
  const match = /^\/api\/workflow-builders(?:\/([a-zA-Z0-9_-]{1,128})(?:\/(messages|abort))?)?$/.exec(pathname);
  if (!match) { send(response, 400, { error: 'Invalid workflow builder resource' }); return true; }
  const id = match[1], action = match[2];
  try {
    if (request.method === 'GET' && id && !action) send(response, 200, service.view(id));
    else if (request.method === 'DELETE' && id && !action) { await service.close(id); send(response, 200, { deleted: true }); }
    else if (request.method === 'POST' && (!id || action)) {
      let text: string;
      try { text = await readBody(request, action ? 200_000 : 300_000); }
      catch { throw new WorkflowBuilderRequestError(413, 'Workflow builder body too large'); }
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new WorkflowBuilderRequestError(400, 'Invalid workflow builder request'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkflowBuilderRequestError(400, 'Invalid workflow builder request');
      if (!id) send(response, 200, await service.create(body as CreateWorkflowBuilder));
      else if (action === 'messages') {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'text')) throw new WorkflowBuilderRequestError(400, 'Invalid workflow builder request');
        send(response, 200, service.message(id, (body as { text: string }).text));
      } else {
        if (Object.keys(body).length) throw new WorkflowBuilderRequestError(400, 'Invalid workflow builder request');
        send(response, 200, await service.abort(id));
      }
    } else send(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    send(response, error instanceof WorkflowBuilderRequestError ? error.status : 400, { error: error instanceof WorkflowBuilderRequestError ? error.message : 'Invalid workflow builder request' });
  }
  return true;
}
