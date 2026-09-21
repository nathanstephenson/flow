import type { WebUpdateStatus } from '../protocol/update.ts';

export type UpdateController = {
  status(refresh?: boolean): Promise<WebUpdateStatus>;
  start(confirmedVersion: string): Promise<WebUpdateStatus>;
};

/** A safe, actionable refusal that the authenticated browser may display verbatim. */
export class UpdateRefusal extends Error {}
