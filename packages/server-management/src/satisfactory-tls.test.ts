import { randomUUID, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateSatisfactoryTlsIdentity,
  validateSatisfactoryTlsIdentity,
} from './satisfactory-tls.js';

describe('Satisfactory TLS identity', () => {
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
