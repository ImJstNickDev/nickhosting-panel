import { createLogger } from '@nickhosting/core';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { createFileOperationTrace } from './file-operation-trace.js';

function fixture(level: 'debug' | 'info', fail = false, sink = vi.fn()) {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((_error, c) => c.json({ failed: true }, 409));
  app.post('/v1/servers/:id/files', async (c) => {
    c.set('requestId', 'request-fixture');
    const trace = createFileOperationTrace(c, createLogger(sink, { level }), 'mutation');
    let outcome: 'succeeded' | 'failed' = 'failed';
    let response: Response | undefined;
    try {
      await trace.timing.measure('files.rename', async () => {
        if (fail) throw new Error('private-path-and-provider-detail');
      });
      outcome = 'succeeded';
      response = c.body(null, 204);
      return response;
    } finally {
      trace.finish(outcome, response);
    }
  });
  return { app, sink };
}

describe('file operation debug diagnostics', () => {
  it('emits one bounded correlated record and only the total response timing', async () => {
    const { app, sink } = fixture('debug');
    const response = await app.request('/v1/servers/fixture/files', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(response.headers.get('server-timing')).toMatch(/^nh-file;dur=\d+(\.\d+)?$/);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      level: 'debug',
      event: 'server.file_operation',
      data: {
        requestId: 'request-fixture',
        serverId: 'fixture',
        operation: 'mutation',
        outcome: 'succeeded',
        durationMs: expect.any(Number),
        phases: { 'files.rename': { count: 1, totalMs: expect.any(Number) } },
      },
    });
  });
  it('is silent at info level', async () => {
    const { app, sink } = fixture('info');
    const response = await app.request('/v1/servers/fixture/files', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(response.headers.has('server-timing')).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });
  it('preserves failures without logging private error details', async () => {
    const { app, sink } = fixture('debug', true);
    const response = await app.request('/v1/servers/fixture/files', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(sink.mock.calls[0]?.[0].data.outcome).toBe('failed');
    expect(JSON.stringify(sink.mock.calls)).not.toContain('private-path');
  });
  it.each([false, true])(
    'does not let a failing sink change the result: failure=%s',
    async (fail) => {
      const { app } = fixture(
        'debug',
        fail,
        vi.fn(() => {
          throw new Error('sink failed');
        }),
      );
      const response = await app.request('/v1/servers/fixture/files', { method: 'POST' });
      expect(response.status).toBe(fail ? 409 : 204);
    },
  );
});
