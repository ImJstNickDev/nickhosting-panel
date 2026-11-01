import type { createLogger } from '@nickhosting/core';
import { createUploadTiming } from '@nickhosting/server-management';
import type { Context } from 'hono';
import type { Variables } from './app.js';

/** One bounded record per operation. Nested phase totals must not be added together. */
export function createFileOperationTrace(
  c: Context<{ Variables: Variables }>,
  logger: ReturnType<typeof createLogger> | undefined,
  operation: 'copy' | 'mutation',
) {
  const enabled = logger?.isEnabled('debug') ?? false;
  const timing = createUploadTiming(enabled);
  const started = enabled ? performance.now() : 0;
  return {
    enabled,
    timing,
    finish(outcome: 'succeeded' | 'failed', response?: Response) {
      if (!enabled) return;
      const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
      try {
        // Only the total is exposed; provider/authorization details stay in private logs.
        if (response) response.headers.append('Server-Timing', `nh-file;dur=${durationMs}`);
        else c.header('Server-Timing', `nh-file;dur=${durationMs}`, { append: true });
      } catch {}
      try {
        logger?.log('debug', 'server.file_operation', {
          requestId: c.get('requestId'),
          serverId: c.req.param('id'),
          operation,
          outcome,
          durationMs,
          phases: timing.snapshot(),
        });
      } catch {
        // Diagnostic failures never replace an operation result or its original error.
      }
    },
  };
}
