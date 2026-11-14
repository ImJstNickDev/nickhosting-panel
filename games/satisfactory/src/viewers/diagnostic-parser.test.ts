import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isCertificateName, isCrashContextName } from './diagnostic-names.js';
import {
  decodeDiagnostic,
  diagnosticReadLimit,
  parseCertificates,
  parseCrashContext,
} from './diagnostic-parser.js';

const bytes = (text: string) => new TextEncoder().encode(text);
// Public-only fixture certificate; the ephemeral private key was discarded.
const pem = `-----BEGIN CERTIFICATE-----
MIIBkzCCATmgAwIBAgIUdt/KpcGjvxz1wgLkQRhqJQHqH4MwCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUZmFjdG9yeS5leGFtcGxlLnRlc3QwHhcNMjYxMTExMDIyNTM5
WhcNMjYxMTEzMDIyNTM5WjAfMR0wGwYDVQQDDBRmYWN0b3J5LmV4YW1wbGUudGVz
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABIGG3nReL1c1seskqyUxVsM5xSz2
Kjhm65E2Qw2/BIwrF6OAmbk2hlbOTdX+N6cqodGri78r9qLbkyKWFNVazXqjUzBR
MB0GA1UdDgQWBBSN9YyrjWJYyc5bLM9ItQnu3nvT8TAfBgNVHSMEGDAWgBSN9Yyr
jWJYyc5bLM9ItQnu3nvT8TAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gA
MEUCIAJyPZhUlemaJh/ZydicOfym9QTJ4EiA4S+aD2OFZPGRAiEA+dVedLu4b8qx
sVs3alIqo9YHvMyHNCaaB1ZJN8oO/7M=
-----END CERTIFICATE-----
`;
describe('diagnostic metadata bounds and certificate parsing', () => {
  it('matches public names and the exact native crash context', () => {
    expect(isCrashContextName('CrashContext.runtime-xml')).toBe(true);
    expect(isCrashContextName('Other.xml')).toBe(false);
    expect(isCertificateName('cert_chain.pem')).toBe(true);
    expect(isCertificateName('private_key.pem')).toBe(false);
    expect(isCertificateName('privkey.crt')).toBe(false);
  });
  it('rejects oversized and malformed encoding before parsing', () => {
    expect(() => decodeDiagnostic(new Uint8Array(diagnosticReadLimit))).toThrow('tooLarge');
    expect(() => decodeDiagnostic(new Uint8Array([0xff]))).toThrow();
    expect(() => decodeDiagnostic(bytes('a\0b'))).toThrow();
  });
  it('rejects XML entity and document declarations before DOM parsing', () => {
    expect(() => parseCrashContext(bytes('<!DOCTYPE x SYSTEM "file:///etc/passwd"><x/>'))).toThrow(
      'unavailable',
    );
    expect(() => parseCrashContext(bytes('<!ENTITY x "value"><x/>'))).toThrow('unavailable');
  });
  it('reads a chain and agrees with the native X509 fingerprint', async () => {
    const chain = await parseCertificates(bytes(pem + pem));
    expect(chain).toHaveLength(2);
    expect(chain[0]?.subject).toContain('factory.example.test');
    expect(chain[0]?.fingerprint).toBe(new X509Certificate(pem).fingerprint256);
    expect(chain[0]?.notAfter).toBe(new Date(new X509Certificate(pem).validTo).toISOString());
  });
  it('rejects private material even in a certificate chain', async () => {
    await expect(
      parseCertificates(
        bytes(`${pem}\n-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----`),
      ),
    ).rejects.toThrow('privateKey');
  });
  it('rejects junk, invalid certificates and excessive chains', async () => {
    for (const text of [
      '',
      'hello',
      `${pem}junk`,
      '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----',
      pem.repeat(17),
    ])
      await expect(parseCertificates(bytes(text))).rejects.toThrow();
  });
});
