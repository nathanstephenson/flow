#!/usr/bin/env node
import { isSea } from 'node:sea';

if (!isSea() && import.meta.url.endsWith('.js')) {
  console.error('Use the flow executable, not the internal CLI entry');
  process.exitCode = 1;
} else {
  void import('./application.ts').then(({ runCli }) => runCli()).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
