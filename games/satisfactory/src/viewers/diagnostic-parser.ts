import { X509Certificate } from '@peculiar/x509';

export const diagnosticReadLimit = 65_536;
export type DiagnosticField = { key: string; value: string };
export function decodeDiagnostic(bytes: Uint8Array) {
  if (bytes.byteLength >= diagnosticReadLimit) throw new Error('tooLarge');
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  const value = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (value.includes('\0')) throw new Error('unavailable');
  return value;
}
const crashFields = [
  'CrashGUID',
  'CrashType',
  'ErrorMessage',
  'GameName',
  'EngineVersion',
  'BuildVersion',
  'BuildConfiguration',
  'PlatformName',
  'SecondsSinceStart',
  'CallStack',
  'PCallStack',
] as const;
export function parseCrashContext(bytes: Uint8Array): DiagnosticField[] {
  const text = decodeDiagnostic(bytes);
  // Reject declarations before handing anything to the browser XML parser.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('unavailable');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'FGenericCrashContext')
    throw new Error('unavailable');
  const properties = Array.from(doc.documentElement.children).find(
    (node) => node.tagName === 'RuntimeProperties',
  );
  if (!properties) throw new Error('unavailable');
  return crashFields.flatMap((key) => {
    const node = Array.from(properties.children).find((item) => item.tagName === key);
    const value = node?.textContent?.trim();
    return value ? [{ key, value }] : [];
  });
}
export type CertificateMetadata = {
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
};
export async function parseCertificates(bytes: Uint8Array): Promise<CertificateMetadata[]> {
  const text = decodeDiagnostic(bytes);
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(text)) throw new Error('privateKey');
  const blocks = [
    ...text.matchAll(
      /-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/g,
    ),
  ];
  if (
    !blocks.length ||
    blocks.length > 16 ||
    text
      .replace(/-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+?\s*-----END CERTIFICATE-----/g, '')
      .trim()
  )
    throw new Error('unavailable');
  return Promise.all(
    blocks.map(async (block) => {
      const cert = new X509Certificate(block[0]);
      const fingerprint = [...new Uint8Array(await cert.getThumbprint('SHA-256'))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(':')
        .toUpperCase();
      return {
        subject: cert.subject,
        issuer: cert.issuer,
        serial: cert.serialNumber,
        notBefore: cert.notBefore.toISOString(),
        notAfter: cert.notAfter.toISOString(),
        fingerprint,
      };
    }),
  );
}
