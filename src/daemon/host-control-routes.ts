import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostIdentity } from './ownership.ts';
import { readBody, send } from './http.ts';

export type HostControl = {
  identity: HostIdentity;
  hasActiveWork(): boolean;
  stop(): Promise<void>;
};

export async function hostControlRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  control: HostControl,
  admission: { isStopping(): boolean; hasPending(): boolean; stop(): void },
): Promise<void> {
  if (path === '/api/host' && request.method === 'GET') {
    const { token: _token, ...status } = control.identity;
    send(response, 200, { ...status, stopping: admission.isStopping() });
    return;
  }
  if (path !== '/api/host/stop' || request.method !== 'POST') {
    send(response, 405, {});
    return;
  }
  try {
    const body = JSON.parse(await readBody(request, 4096));
    if (body.instanceId !== control.identity.instanceId) {
      send(response, 409, { error: 'Session Host instance changed' });
      return;
    }
    if (!admission.isStopping() && (admission.hasPending() || control.hasActiveWork()) && body.force !== true) {
      send(response, 409, { error: 'Session Host has active work; use --force to interrupt it' });
      return;
    }
    admission.stop();
    send(response, 202, { stopping: true });
    setImmediate(() => { void control.stop().catch(error => console.error(error)); });
  } catch (error) {
    send(response, 400, { error: String(error) });
  }
}
