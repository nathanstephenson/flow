import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { scheduleSettingsValidator, occurrenceSettings, storageId, timingValidator, nextOccurrence } from '../workflows/schedules.ts';
import { ScheduleRecordNotFound, ScheduleRevisionConflict } from '../workflows/schedule-store.ts';
import { ScheduleValidationError } from '../workflows/schedule-errors.ts';
import type { WorkflowScheduleService } from './workflow-schedules.ts';
import type { WorkflowExecutionService } from './workflow-executions.ts';
import { WorkflowConflict, WorkflowValidationError } from './workflow-execution-values.ts';

class BodyTooLarge extends Error {}
const revision = z.number().int().positive();
const createBody = z.object({ settings: scheduleSettingsValidator, enabled: z.boolean().default(false) }).strict();
const editBody = createBody.extend({ revision });
function requestValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ScheduleValidationError('Invalid request value');
  return parsed.data;
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1_000_000) throw new BodyTooLarge(); chunks.push(bytes); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new ScheduleValidationError('Invalid request body'); }
}
function requestId(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new ScheduleValidationError('Invalid route identity'); }
  return requestValue(storageId, decoded);
}
export async function workflowScheduleRoutes(request: IncomingMessage, response: ServerResponse, url: URL, service?: WorkflowScheduleService, executions?: WorkflowExecutionService): Promise<boolean> {
  if (!/^\/api\/workflow-(schedules|occurrences)(?:\/|$)/.test(url.pathname)) return false;
  const reply = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (!service || !executions) { reply(404, { error: 'Schedules unavailable' }); return true; }
  try {
    const match = /^\/api\/workflow-(schedules|occurrences)(?:\/([^/]+)(?:\/(enable|pause|history|execution|activity|cancel|retry-attachment))?)?$/.exec(url.pathname);
    if (!match) throw new ScheduleValidationError('Invalid route');
    const kind = match[1], id = match[2] === undefined ? undefined : requestId(match[2]), action = match[3];
    const method = request.method;
    const allowed = action === 'history' || kind === 'occurrences' && !id ? ['scheduleId', 'before', 'limit'] : action === 'execution' ? ['invocationId'] : action === 'activity' ? ['invocationId', 'stepId', 'attempt', 'after', 'before', 'latest', 'limit'] : [];
    for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ScheduleValidationError('Invalid query');
    if (kind === 'schedules' && id === 'preview' && method === 'POST') {
      const { timing } = requestValue(z.object({ timing: timingValidator }).strict(), await body(request));
      reply(200, { nextDue: nextOccurrence(timing, Date.now()) });
    } else if (kind === 'schedules' && !id && method === 'GET') reply(200, { schedules: service.store.listSchedules(), cleanupWarnings: service.store.cleanupWarnings() });
    else if (kind === 'schedules' && !id && method === 'POST') {
      const input = requestValue(createBody, await body(request)); reply(201, { schedule: await service.create(input.settings, input.enabled) });
    } else if (kind === 'schedules' && id && !action && method === 'GET') reply(200, { schedule: service.store.getSchedule(id) });
    else if (kind === 'schedules' && id && !action && method === 'PUT') {
      const input = requestValue(editBody, await body(request)); reply(200, { schedule: await service.update(id, input.revision, input.settings, input.enabled) });
    } else if (kind === 'schedules' && id && !action && method === 'DELETE') {
      const input = requestValue(z.object({ revision }).strict(), await body(request)); await service.delete(id, input.revision); reply(200, { deleted: true });
    } else if (kind === 'schedules' && id && (action === 'enable' || action === 'pause') && method === 'POST') {
      const input = requestValue(z.object({ revision }).strict(), await body(request)); const schedule = service.store.getSchedule(id);
      reply(200, { schedule: action === 'pause' ? await service.pause(id, input.revision) : await service.update(id, input.revision, occurrenceSettings(schedule), true) });
    } else if (method === 'GET' && (kind === 'schedules' && action === 'history' || kind === 'occurrences' && !id)) {
      const query = url.searchParams;
      reply(200, service.store.page({ ...(kind === 'schedules' ? { scheduleId: id! } : query.has('scheduleId') ? { scheduleId: requestValue(storageId, query.get('scheduleId')) } : {}), ...(query.has('before') ? { before: requestValue(storageId, query.get('before')) } : {}), limit: requestValue(z.coerce.number().int().min(1).max(200), query.get('limit') ?? 50) }));
    } else if (kind === 'occurrences' && id) {
      const occurrence = service.store.getOccurrence(id);
      if (method === 'GET' && !action) reply(200, { occurrence });
      else if (method === 'POST' && action === 'retry-attachment') {
        requestValue(z.object({}).strict(), await body(request)); await service.retryAttachment(id); reply(200, { occurrence: service.store.getOccurrence(id) });
      } else if (method === 'POST' && action === 'cancel') {
        requestValue(z.object({}).strict(), await body(request)); await service.cancel(id); reply(200, { occurrence: service.store.getOccurrence(id) });
      } else if (method === 'GET' && (action === 'execution' || action === 'activity')) {
        if (!occurrence.executionId) throw new ScheduleRecordNotFound('Execution not found');
        const owner = `occurrence-${id}`, executionId = occurrence.executionId;
        const query = url.searchParams;
        if (action === 'execution') reply(200, executions.view(owner, executionId, query.has('invocationId') ? requestValue(storageId, query.get('invocationId')) : undefined));
        else {
          const number = (name: string) => requestValue(z.coerce.number().int().min(name === 'after' ? 0 : 1).safe(), query.get(name));
          if (query.has('latest') && query.get('latest') !== 'true' || query.has('after') && (query.has('before') || query.has('latest'))) throw new ScheduleValidationError('Invalid activity cursor');
          reply(200, await executions.activity(owner, executionId, { ...(query.has('invocationId') ? { invocationId: requestValue(storageId, query.get('invocationId')) } : {}), ...(query.has('stepId') ? { stepId: query.get('stepId')! } : {}), ...(query.has('attempt') ? { attempt: number('attempt') } : {}), ...(query.has('after') ? { after: number('after') } : {}), ...(query.has('before') ? { before: number('before') } : {}), ...(query.has('latest') ? { latest: true } : {}), ...(query.has('limit') ? { limit: number('limit') } : {}) }));
        }
      } else reply(405, { error: 'Method not allowed or execution unavailable' });
    } else reply(405, { error: 'Method not allowed' });
  } catch (error) {
    const status = error instanceof ScheduleRevisionConflict || error instanceof WorkflowConflict ? 409
      : error instanceof ScheduleRecordNotFound ? 404
      : error instanceof BodyTooLarge ? 413
      : error instanceof ScheduleValidationError || error instanceof WorkflowValidationError ? 400 : 500;
    if (status === 500) console.error('Workflow Schedule request failed. An internal operation is unavailable.');
    reply(status, { error: status === 409 ? 'Schedule or Workflow changed; reload before editing' : status === 404 ? 'Schedule, occurrence or execution not found' : status === 413 ? 'Body too large' : status === 500 ? 'Schedule operation unavailable. Check Session Host diagnostics.' : 'Invalid schedule request. Check timing, inputs, Project, local branch and MCP selection.' });
  }
  return true;
}
