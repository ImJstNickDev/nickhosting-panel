import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';

const settings = {
  managementUrl: 'http://viewer.example.test:8080',
  dataRoot: '/srv/servers',
  instanceId: '10000000-0000-4000-8000-000000000000',
  host: 'sftp.example.test',
  hostFingerprint: `SHA256:${'A'.repeat(43)}`,
  cacheRoot: './mountdata/viewer-cache',
};
describe('optional private viewer configuration', () => {
  it('is disabled by default and follows Owner/environment precedence independently of external SFTP', () => {
    expect(resolveConfig().values.fileViewers).toBeUndefined();
    const owner = resolveConfig({ fileViewers: settings });
    expect(owner.values.fileViewers).toMatchObject({
      port: 2022,
      maxConnections: 16,
      cacheBytes: 1073741824,
    });
    const override = { ...settings, host: 'override.example.test' };
    const resolved = resolveConfig(
      { fileViewers: settings },
      { NH_FILE_VIEWERS: JSON.stringify(override) },
    );
    expect(resolved.values.fileViewers?.host).toBe(override.host);
    expect(resolved.lockedKeys).toContain('fileViewers');
    expect(resolved.values.sftpgoBaseUrl).toBeUndefined();
  });
  it.each([
    { hostFingerprint: '' },
    { hostFingerprint: 'accept-anything' },
    { dataRoot: '/srv/../private' },
    { cacheRoot: './mountdata/../private' },
    { cacheRoot: '/tmp/viewers' },
    { port: 0 },
    { maxConnections: 0 },
    { managementUrl: 'http://user:secret@example.test' },
  ])('rejects malformed transport or cache settings %j', (invalid) => {
    expect(() => resolveConfig({ fileViewers: { ...settings, ...invalid } })).toThrow(
      'configuration_invalid',
    );
  });
});
