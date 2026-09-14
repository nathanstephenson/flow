import type { IncomingMessage, ServerResponse } from 'node:http';
import { validSecretName } from '../protocol/secrets.ts';
import { validateDefinition } from '../workflows/graph.ts';
import type { WorkflowStore } from '../workflows/store.ts';
import type { SecretStore } from './secret-store.ts';

export async function workflowRoutes(request: IncomingMessage, response: ServerResponse, pathname: string, workflows?: WorkflowStore, secrets?: SecretStore): Promise<boolean> {
  const match = /^\/api\/(workflows|secrets)(?:\/(.*))?$/.exec(pathname);
  if (!match) return false;
  const reply = (status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const secret = match[1] === 'secrets';
  if (secret ? !secrets : !workflows) { reply(404, { error: 'Not available' }); return true; }
  let id: string | undefined;
  try {
    id = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (id !== undefined && !(secret ? validSecretName(id) : /^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new Error();
  } catch { reply(400, { error: 'Invalid resource name' }); return true; }
  try {
    if (request.method === 'GET') {
      if (secret) {
        if (id === undefined) reply(200, { names: secrets!.list() });
        else if (secrets!.has(id)) reply(200, { name: id });
        else reply(404, { error: 'Not found' });
      } else reply(200, id === undefined ? { workflows: workflows!.listDefinitions() } : { workflow: workflows!.getDefinition(id) });
    } else if (request.method === 'DELETE' && id !== undefined) {
      if (secret) secrets!.delete(id); else workflows!.deleteDefinition(id);
      reply(200, { deleted: true });
    } else if (request.method === 'PUT' && id !== undefined) {
      let body: unknown;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > (secret ? 400_000 : 1_000_000)) { reply(413, { error: 'Body too large' }); return true; }
          chunks.push(buffer);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { reply(400, { error: 'Invalid JSON body' }); return true; }
      if (secret) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'value'
          || typeof (body as { value?: unknown }).value !== 'string'
          || !(body as { value: string }).value.length || Buffer.byteLength((body as { value: string }).value) > 64_000) {
          reply(400, { error: 'Expected a secret value of 1 to 64000 bytes' }); return true;
        }
        secrets!.set(id, (body as { value: string }).value);
        reply(200, { name: id });
      } else {
        let definition;
        try {
          definition = validateDefinition(body).definition;
          if (definition.id !== id) throw new Error();
        } catch { reply(400, { error: 'Invalid workflow definition' }); return true; }
        workflows!.saveDefinition(definition);
        reply(200, { workflow: definition });
      }
    } else reply(405, { error: 'Method not allowed' });
  } catch (error) {
    reply((error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 404 : 500, { error: 'Resource unavailable' });
  }
  return true;
}
