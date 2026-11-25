import { createServer } from 'node:http';

export function createSystemdTestRegistry(handler) {
  return createServer((request, response) => {
    response.shouldKeepAlive = false;
    return handler(request, response);
  });
}
