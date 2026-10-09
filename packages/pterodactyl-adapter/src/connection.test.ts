import { describe, expect, it, vi } from 'vitest';
import { validateConnection } from './index.js';

describe('setup-only adapter', () => {
  it('validates both credentials with bounded read-only requests and no redirects', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ object: 'list', data: [] }));
    await validateConnection(
      {
        baseURL: 'https://panel.example.com',
        applicationKey: 'fixture-application',
        clientKey: 'fixture-client',
      },
      request,
    );
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, options] of request.mock.calls) {
      expect(options?.method).toBe('GET');
      expect(options?.redirect).toBe('error');
    }
  });
  it('maps credential/upstream failures without leaking bodies or keys', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private upstream body', { status: 401 }));
    await expect(
      validateConnection(
        { baseURL: 'https://panel.example.com', applicationKey: 'fixture-secret' },
        request,
      ),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
  });
  it('rejects invalid destinations and schema', async () => {
    await expect(
      validateConnection({ baseURL: 'file:///fixture', applicationKey: 'test' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      validateConnection(
        { baseURL: 'https://panel.example.com', applicationKey: 'test' },
        async () => Response.json({ unexpected: true }),
      ),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
  });
});
