import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateDefinition } from '../workflows/graph.ts';
import type { WorkflowStore } from '../workflows/store.ts';
import { WorkflowConflict, type WorkflowExecutionService } from './workflow-executions.ts';
import type { Json } from '../protocol/workflows.ts';
import type { RecoverWorkflow } from '../protocol/workflow-executions.ts';
import { workflowRequestError } from './workflow-routes.ts';

export async function workflowExecutionRoutes(request: IncomingMessage, response: ServerResponse, pathname: string, service?: WorkflowExecutionService, store?: WorkflowStore): Promise<boolean> {
  const match = /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/workflows(?:\/([a-zA-Z0-9_-]+)(?:\/(cancel|recover|enquiry|permission|activity))?)?$/.exec(pathname);
  const discovery = /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/workflow-mcp(?:\/([a-zA-Z0-9_-]+))?$/.exec(pathname);
  const test = pathname === '/api/workflows/test' && request.method === 'POST';
  const runtime = pathname === '/api/workflow-runtime';
  if (!match && !test && !runtime && !discovery) return false;
  const reply = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (!service || !store) { reply(404, { error: 'Workflow execution is unavailable' }); return true; }
  try {
    if (request.method === 'GET' && discovery) reply(200, discovery[2] ? await service.discoverMcp(discovery[1]!, discovery[2]) : service.mcpConnections(discovery[1]!));
    else if (request.method === 'GET' && runtime) reply(200, service.status());
    else if (request.method === 'GET' && match?.[3] === 'activity') {
      const query = new URL(request.url!, 'http://localhost').searchParams;
      reply(200, await service.activity(match[1]!, match[2]!, { after: Number(query.get('after') ?? 0), limit: Number(query.get('limit') ?? 100), ...(query.has('stepId') ? { stepId: query.get('stepId')! } : {}), ...(query.has('attempt') ? { attempt: Number(query.get('attempt')) } : {}) }));
    }
    else if (request.method === 'GET' && match && !match[3]) reply(200, match[2] ? service.view(match[1]!, match[2]) : service.list(match[1]!));
    else if (request.method === 'POST' && !runtime) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) { const bytes = Buffer.from(chunk); chunks.push(bytes); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      const keys = (...names: string[]) => { if (Object.keys(body).some(key => !names.includes(key))) throw new Error(); };
      const string = (key: string) => { if (typeof body[key] !== 'string' || !body[key].length) throw new Error(); return body[key] as string; };
      const input = () => { if (!Object.hasOwn(body, 'input')) throw new Error(); return body.input as Json; };
      if (test) {
        keys('definition', 'sessionId', 'stepId', 'input');
        reply(200, await service.start(string('sessionId'), validateDefinition(body.definition).definition, input(), string('stepId')));
      } else if (!match![2]) {
        keys('workflowId', 'input');
        reply(200, await service.start(match![1]!, store.getDefinition(string('workflowId')), input()));
      } else {
        const sessionId = match![1]!, executionId = match![2]!;
        switch (match![3]) {
          case 'cancel': keys(); reply(200, await service.cancel(sessionId, executionId)); break;
          case 'recover': {
            if (body.kind === 'continue') keys('kind');
            else if (body.kind === 'extend-loop') {
              keys('kind', 'headerId', 'activation', 'try', 'guidance'); string('headerId');
              if (![body.activation, body.try].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error();
              if (body.guidance !== undefined && (typeof body.guidance !== 'string' || body.guidance.length > 100_000)) throw new Error();
            }
            else if (body.kind === 'retry') { keys('kind', 'stepId'); string('stepId'); }
            else if (body.kind === 'supply') { keys('kind', 'stepId', 'output'); string('stepId'); if (!Object.hasOwn(body, 'output')) throw new Error(); }
            else throw new Error();
            reply(200, await service.recover(sessionId, executionId, body as RecoverWorkflow)); break;
          }
          case 'enquiry':
            keys('subagentId', 'askId', 'answers'); string('subagentId'); string('askId');
            if (!Array.isArray(body.answers) || !body.answers.every((answer: unknown) => Array.isArray(answer) && answer.every(value => typeof value === 'string'))) throw new Error();
            reply(200, await service.answer(sessionId, executionId, body)); break;
          case 'permission':
            keys('subagentId', 'callId', 'decision'); string('subagentId'); string('callId');
            if (!['allow', 'deny', 'always'].includes(body.decision)) throw new Error();
            reply(200, await service.answer(sessionId, executionId, body)); break;
          default: reply(405, { error: 'Method not allowed' });
        }
      }
    } else reply(405, { error: 'Method not allowed' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    reply(error instanceof WorkflowConflict ? 409 : code === 'ENOENT' ? 404 : code ? 500 : 400, { error: code ? 'Workflow resource unavailable' : workflowRequestError(error) });
  }
  return true;
}
