import { describe, expect, it, vi } from 'vitest';
import { discoverNickHostingExtension } from './blueprint.js';

const capabilities = {
  schemaVersion: 1,
  extension: 'nickhosting',
  extensionVersion: '0.1.0-dev',
  target: { panel: '1.11.11', blueprint: 'beta-2025-09' },
  capabilities: { clientKeyManagement: false, serverChangeEvents: false },
};
const options = {
  baseURL: 'https://panel.example.com',
  applicationKey: 'fixture-application',
  clientKey: 'fixture-client',
};
describe('Blueprint extension discovery', () => {
  it('uses only the Application transport and preserves unavailable capabilities', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(capabilities));
    expect(await discoverNickHostingExtension({ ...options, fetcher })).toEqual(capabilities);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Missing discovery request');
    const [url, init] = call;
    expect(String(url)).toBe(
      'https://panel.example.com/api/application/extensions/nickhosting/capabilities',
    );
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-application');
    expect(init?.body).toBeUndefined();
  });
  it('returns null only for a missing extension', async () => {
    expect(
      await discoverNickHostingExtension({
        ...options,
        fetcher: async () => new Response(null, { status: 404 }),
      }),
    ).toBeNull();
  });
  it.each([401, 403, 429, 500])('does not hide upstream HTTP %s as missing', async (status) => {
    await expect(
      discoverNickHostingExtension({
        ...options,
        fetcher: async () => new Response('private upstream body', { status }),
      }),
    ).rejects.toMatchObject({ upstreamStatus: status });
  });
  it.each([
    { ...capabilities, schemaVersion: 2 },
    { ...capabilities, extension: 'unrelated' },
    { ...capabilities, capabilities: {} },
    { ...capabilities, capabilities: { clientKeyManagement: 'true', serverChangeEvents: false } },
    { ...capabilities, token: 'unexpected-secret' },
  ])('rejects incompatible or unexpected payloads without surfacing the body', async (payload) => {
    await expect(
      discoverNickHostingExtension({ ...options, fetcher: async () => Response.json(payload) }),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });
});
