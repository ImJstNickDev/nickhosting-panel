import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateSatisfactoryTlsIdentity,
  validateSatisfactoryTlsIdentity,
} from './satisfactory-tls.js';

describe('Satisfactory TLS identity', () => {
  it('does not fail when OpenSSL emits a large key-generation progress stream', async () => {
    const openssl = execFileSync('which', ['openssl'], { encoding: 'utf8' }).trim();
    const directory = await mkdtemp(join(tmpdir(), 'nickhosting-openssl-test-'));
    const oldPath = process.env.PATH;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    try {
      await writeFile(
        join(directory, 'openssl'),
        `#!/bin/sh\nprintf '%s' '${'.'.repeat(65536)}' >&2\nexec ${quote(openssl)} "$@"\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${directory}:${oldPath ?? ''}`;
      expect(
        validateSatisfactoryTlsIdentity(await generateSatisfactoryTlsIdentity(randomUUID())),
      ).toBeDefined();
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
  it('generates unique matching identities and rejects cross-server key substitution', async () => {
    const firstId = randomUUID();
    const first = await generateSatisfactoryTlsIdentity(firstId);
    const second = await generateSatisfactoryTlsIdentity(randomUUID());
    expect(new X509Certificate(first.certificatePem).subject).toContain(firstId);
    expect(first.privateKeyPem).not.toBe(second.privateKeyPem);
    expect(() =>
      validateSatisfactoryTlsIdentity({ ...first, privateKeyPem: second.privateKeyPem }),
    ).toThrow();
    expect(validateSatisfactoryTlsIdentity(first)).toEqual(first);
  }, 60000);
  it('rejects untrusted identifiers before invoking certificate generation', async () => {
    await expect(generateSatisfactoryTlsIdentity('../other')).rejects.toThrow();
    expect(() =>
      validateSatisfactoryTlsIdentity({ certificatePem: 'invalid', privateKeyPem: 'invalid' }),
    ).toThrow();
  });
});
