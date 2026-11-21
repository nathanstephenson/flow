import type { RequestListener, Server } from 'node:http';

export function createSystemdTestRegistry(handler: RequestListener): Server;
