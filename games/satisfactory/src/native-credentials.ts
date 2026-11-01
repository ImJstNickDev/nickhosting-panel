/** Native USaveGame credential layout verified against dedicated server build 513885.
 * Missing properties remain absent: Unreal may omit defaults, but this decoder does
 * not infer authentication policy from that omission. Never log its return value.
 */
export interface NativeSatisfactoryCredentials {
  build: number;
  serverName: string;
  autoLoadSessionName?: string;
  serverSecret: string;
  adminPassword?: { hash: string; salt: string };
  clientPassword?: { hash: string; salt: string };
  /** Native FGuid's four uint32 components, in serialization order. */
  apiTokenSeed?: readonly [number, number, number, number];
}

const MAX_BYTES = 256 * 1024;
const PROFILE_BUILD = 513885;
const SERVER_PACKAGE = '/Script/FactoryDedicatedServer';

class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) {
      throw new Error('Invalid native settings');
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  u8(): number {
    return this.take(1).readUInt8();
  }
  u16(): number {
    return this.take(2).readUInt16LE();
  }
  u32(): number {
    return this.take(4).readUInt32LE();
  }
  string(max = 4096): string {
    const length = this.take(4).readInt32LE();
    if (length === 0) return '';
    if (Math.abs(length) > max + 1) throw new Error('Invalid native settings');
    const wide = length < 0;
    const bytes = this.take(Math.abs(length) * (wide ? 2 : 1));
    if (wide ? bytes.readUInt16LE(bytes.length - 2) !== 0 : bytes.at(-1) !== 0) {
      throw new Error('Invalid native settings');
    }
    const value = new TextDecoder(wide ? 'utf-16le' : 'utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes.subarray(0, bytes.length - (wide ? 2 : 1)));
    if (value.includes('\0')) throw new Error('Invalid native settings');
    return value;
  }
  end(): void {
    if (this.offset !== this.bytes.length) throw new Error('Invalid native settings');
  }
}

type TypeNode = { name: string; children: TypeNode[] };
function typeNode(reader: Reader, depth = 0): TypeNode {
  if (depth > 3) throw new Error('Invalid native settings');
  const name = reader.string(128);
  const count = reader.u32();
  if (count > 2) throw new Error('Invalid native settings');
  return { name, children: Array.from({ length: count }, () => typeNode(reader, depth + 1)) };
}

interface Property {
  type: TypeNode;
  flags: number;
  value: Reader;
}
function properties(reader: Reader): Map<string, Property> {
  const result = new Map<string, Property>();
  for (let count = 0; count <= 16; count++) {
    const name = reader.string(128);
    if (name === 'None') return result;
    if (!name || result.has(name)) throw new Error('Invalid native settings');
    const type = typeNode(reader);
    const size = reader.u32();
    const flags = reader.u8();
    // This profile contains scalar properties only: no index, GUID or extensions.
    if (![0, 8, 16].includes(flags)) throw new Error('Invalid native settings');
    result.set(name, { type, flags, value: new Reader(reader.take(size)) });
  }
  throw new Error('Invalid native settings');
}

function scalar(property: Property, name: string, flags = 0): Reader {
  if (property.type.name !== name || property.type.children.length || property.flags !== flags) {
    throw new Error('Invalid native settings');
  }
  return property.value;
}

function structure(property: Property, name: string, pkg: string, flags = 0): Reader {
  const node = property.type;
  const child = node.children[0];
  const leaf = child?.children[0];
  if (
    node.name !== 'StructProperty' ||
    node.children.length !== 1 ||
    child?.name !== name ||
    child.children.length !== 1 ||
    leaf?.name !== pkg ||
    leaf.children.length !== 0 ||
    property.flags !== flags
  ) {
    throw new Error('Invalid native settings');
  }
  return property.value;
}

function textProperty(property: Property, max = 4096): string {
  const reader = scalar(property, 'StrProperty');
  const value = reader.string(max);
  reader.end();
  return value;
}

function password(property: Property): { hash: string; salt: string } {
  const reader = structure(property, 'FGStoredPasswordData', SERVER_PACKAGE);
  const fields = properties(reader);
  reader.end();
  if (fields.size !== 2 || !fields.has('PasswordHash') || !fields.has('PasswordSalt')) {
    throw new Error('Invalid native settings');
  }
  const hash = textProperty(fields.get('PasswordHash') as Property, 128);
  const salt = textProperty(fields.get('PasswordSalt') as Property, 64);
  if (
    !((hash === '' && salt === '') || (/^[a-f\d]{128}$/i.test(hash) && /^[a-f\d]{64}$/i.test(salt)))
  ) {
    throw new Error('Invalid native settings');
  }
  return { hash, salt };
}

/** Strictly decode the supported native profile; unsupported or malformed input is unavailable. */
export function decodeSatisfactoryNativeCredentials(
  input: Uint8Array,
): NativeSatisfactoryCredentials | undefined {
  if (input.byteLength > MAX_BYTES) return undefined;
  try {
    const reader = new Reader(Buffer.from(input));
    if (
      reader.u32() !== 0x53415647 ||
      reader.u32() !== 3 ||
      reader.u32() !== 522 ||
      reader.u32() !== 1017 ||
      reader.u16() !== 5 ||
      reader.u16() !== 6 ||
      reader.u16() !== 1 ||
      reader.u32() !== 0x80000000 + PROFILE_BUILD ||
      reader.string(128) !== '++FactoryGame+rel-main-anniversary-2026' ||
      reader.u32() !== 3
    )
      return undefined;
    const customCount = reader.u32();
    if (customCount !== 79) return undefined;
    reader.take(customCount * 20);
    if (reader.string(128) !== `${SERVER_PACKAGE}.FGServerSettings` || reader.u8() !== 0)
      return undefined;
    const fields = properties(reader);
    if (reader.u32() !== 0) return undefined;
    reader.end();
    const allowed = new Set([
      'ServerName',
      'AutoLoadSessionName',
      'AdminPassword',
      'ClientPassword',
      'APITokenSeed',
      'ServerSecret',
      'CertificateData',
      'AgreeToCrashUploadRequested',
    ]);
    if ([...fields.keys()].some((name) => !allowed.has(name))) return undefined;
    const name = fields.get('ServerName');
    const secret = fields.get('ServerSecret');
    if (!name || !secret) return undefined;
    const serverSecret = textProperty(secret, 512);
    if (!/^[a-f\d]{512}$/i.test(serverSecret)) return undefined;
    const result: NativeSatisfactoryCredentials = {
      build: PROFILE_BUILD,
      serverName: textProperty(name),
      serverSecret,
    };
    const session = fields.get('AutoLoadSessionName');
    if (session) result.autoLoadSessionName = textProperty(session);
    const admin = fields.get('AdminPassword');
    if (admin) result.adminPassword = password(admin);
    const client = fields.get('ClientPassword');
    if (client) result.clientPassword = password(client);
    const seed = fields.get('APITokenSeed');
    if (seed) {
      const data = structure(seed, 'Guid', '/Script/CoreUObject', 8);
      result.apiTokenSeed = [data.u32(), data.u32(), data.u32(), data.u32()];
      data.end();
    }
    const certificate = fields.get('CertificateData');
    if (certificate) structure(certificate, 'FGGeneratedCertificateData', SERVER_PACKAGE, 8);
    const crash = fields.get('AgreeToCrashUploadRequested');
    if (crash) scalar(crash, 'BoolProperty', crash.flags === 16 ? 16 : 0).end();
    return result;
  } catch {
    return undefined;
  }
}
