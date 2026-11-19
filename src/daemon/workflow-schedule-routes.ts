import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { scheduleSettingsValidator, occurrenceSettings, storageId, timingValidator, nextOccurrence } from '../workflows/schedules.ts';
import { ScheduleRecordNotFound, ScheduleRevisionConflict } from '../workflows/schedule-store.ts';
import type { WorkflowScheduleService } from './workflow-schedules.ts';
import type { WorkflowExecutionService } from './workflow-executions.ts';

const revision = z.number().int().positive();
const createBody = z.object({ settings: scheduleSettingsValidator, enabled: z.boolean().default(false) }).strict();
const editBody = createBody.extend({ revision });
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1_000_000) throw Object.assign(new Error('Body too large'), { status: 413 }); chunks.push(bytes); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
export async function workflowScheduleRoutes(request: IncomingMessage, response: ServerResponse, url: URL, service?: WorkflowScheduleService, executions?: WorkflowExecutionService): Promise<boolean> {
  if (!/^\/api\/workflow-(schedules|occurrences)(?:\/|$)/.test(url.pathname)) return false;
  const reply = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (!service || !executions) { reply(404, { error: 'Schedules unavailable' }); return true; }
  try {
    const match = /^\/api\/workflow-(schedules|occurrences)(?:\/([^/]+)(?:\/(enable|pause|history|execution|activity|cancel|retry-attachment))?)?$/.exec(url.pathname);
    if (!match) throw new Error('Invalid route');
    const kind = match[1], id = match[2] === undefined ? undefined : storageId.parse(decodeURIComponent(match[2])), action = match[3];
    const method = request.method;
    const allowed = action === 'history' || kind === 'occurrences' && !id ? ['scheduleId', 'before', 'limit'] : action === 'execution' ? ['invocationId'] : action === 'activity' ? ['invocationId', 'stepId', 'attempt', 'after', 'before', 'latest', 'limit'] : [];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error('Invalid query');
    if (kind === 'schedules' && id === 'preview' && method === 'POST') {
      const timing = timingValidator.parse(z.object({ timing: timingValidator }).strict().parse(await body(request)).timing);
      reply(200, { nextDue: nextOccurrence(timing, Date.now()) });
    } else if (kind === 'schedules' && !id && method === 'GET') reply(200, { schedules: service.store.listSchedules(), cleanupWarnings: service.store.cleanupWarnings() });
    else if (kind === 'schedules' && !id && method === 'POST') {
      const input = createBody.parse(await body(request)); reply(201, { schedule: await service.create(input.settings, input.enabled) });
    } else if (kind === 'schedules' && id && !action && method === 'GET') reply(200, { schedule: service.store.getSchedule(id) });
    else if (kind === 'schedules' && id && !action && method === 'PUT') {
      const input = editBody.parse(await body(request)); reply(200, { schedule: await service.update(id, input.revision, input.settings, input.enabled) });
    } else if (kind === 'schedules' && id && !action && method === 'DELETE') {
      const input = z.object({ revision }).strict().parse(await body(request)); await service.delete(id, input.revision); reply(200, { deleted: true });
    } else if (kind === 'schedules' && id && (action === 'enable' || action === 'pause') && method === 'POST') {
      const input = z.object({ revision }).strict().parse(await body(request)); const schedule = service.store.getSchedule(id);
      reply(200, { schedule: action === 'pause' ? await service.pause(id, input.revision) : await service.update(id, input.revision, occurrenceSettings(schedule), true) });
    } else if (method === 'GET' && (kind === 'schedules' && action === 'history' || kind === 'occurrences' && !id)) {
      const query = url.searchParams;
      reply(200, service.store.page({ ...(kind === 'schedules' ? { scheduleId: id! } : query.has('scheduleId') ? { scheduleId: storageId.parse(query.get('scheduleId')) } : {}), ...(query.has('before') ? { before: storageId.parse(query.get('before')) } : {}), limit: z.coerce.number().int().min(1).max(200).parse(query.get('limit') ?? 50) }));
    } else if (kind === 'occurrences' && id) {
      const occurrence = service.store.getOccurrence(id);
      if (method === 'GET' && !action) reply(200, { occurrence });
      else if (method === 'POST' && action === 'retry-attachment') {
        z.object({}).strict().parse(await body(request)); await service.retryAttachment(id); reply(200, { occurrence: service.store.getOccurrence(id) });
      } else if (method === 'POST' && action === 'cancel') {
        z.object({}).strict().parse(await body(request)); await service.cancel(id); reply(200, { occurrence: service.store.getOccurrence(id) });
      } else if (method === 'GET' && (action === 'execution' || action === 'activity') && occurrence.executionId) {
        const owner = `occurrence-${id}`, executionId = occurrence.executionId;
        const query = url.searchParams;
        if (action === 'execution') reply(200, executions.view(owner, executionId, query.has('invocationId') ? storageId.parse(query.get('invocationId')) : undefined));
        else {
          const number = (name: string) => z.coerce.number().int().nonnegative().safe().parse(query.get(name));
          if (query.has('latest') && query.get('latest') !== 'true') throw new Error('Invalid latest');
          reply(200, await executions.activity(owner, executionId, { ...(query.has('invocationId') ? { invocationId: storageId.parse(query.get('invocationId')) } : {}), ...(query.has('stepId') ? { stepId: query.get('stepId')! } : {}), ...(query.has('attempt') ? { attempt: number('attempt') } : {}), ...(query.has('after') ? { after: number('after') } : {}), ...(query.has('before') ? { before: number('before') } : {}), ...(query.has('latest') ? { latest: true } : {}), ...(query.has('limit') ? { limit: number('limit') } : {}) }));
        }
      } else reply(405, { error: 'Method not allowed or execution unavailable' });
    } else reply(405, { error: 'Method not allowed' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const status = (error as { status?: number }).status ?? (error instanceof ScheduleRevisionConflict ? 409 : error instanceof ScheduleRecordNotFound || code === 'ENOENT' ? 404 : 400);
    // Diagnostics may contain credentials in definitions, secrets, MCP or Git errors. Never echo them.
    reply(status, { error: status === 409 ? 'Schedule changed; reload before editing' : status === 404 ? 'Schedule or occurrence not found' : status === 413 ? 'Body too large' : 'Invalid schedule request. Check timing, inputs, Project, local branch and MCP selection.' });
  }
  return true;
}
