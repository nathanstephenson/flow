#!/usr/bin/env node
import { isSea } from 'node:sea';

if (process.argv[2] === '--flow-isolation-launch' ||
  (process.argv[2] === '--flow-backend-worker' && process.send && process.env.FLOW_BACKEND_WORKER === '1')) {
  void import('../backend/worker/entry.ts').catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    process.disconnect?.();
  });
} else if (!isSea() && import.meta.url.endsWith('.js')) {
  console.error('Use the flow executable, not the internal CLI entry');
  process.exitCode = 1;
} else {
  void import('./application.ts').then(({ runCli }) => runCli()).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
