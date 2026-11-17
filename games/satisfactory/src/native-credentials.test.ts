import { describe, expect, it } from 'vitest';
import { decodeSatisfactoryNativeCredentials } from './native-credentials.js';

const u32 = (value: number) => {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
};
const u16 = (value: number) => {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
};
const str = (value: string, wide = false): Buffer => {
  const text = Buffer.from(`${value}\0`, wide ? 'utf16le' : 'utf8');
  const length = Buffer.alloc(4);
  length.writeInt32LE(wide ? -text.length / 2 : text.length);
  return Buffer.concat([length, text]);
};
type Node = string | [string, Node[]];
const type = (value: Node): Buffer => {
  const [name, children] = typeof value === 'string' ? [value, []] : value;
  return Buffer.concat([str(name), u32(children.length), ...children.map(type)]);
};
const struct = (name: string, pkg = '/Script/FactoryDedicatedServer'): Node => [
  'StructProperty',
  [[name, [pkg]]],
];
const property = (name: string, value: Buffer, node: Node = 'StrProperty', flags = 0) =>
  Buffer.concat([str(name), type(node), u32(value.length), Buffer.from([flags]), value]);
const password = (hash = 'a'.repeat(128), salt = 'B'.repeat(64)) =>
  Buffer.concat([
    property('PasswordHash', str(hash)),
    property('PasswordSalt', str(salt)),
    str('None'),
  ]);
const header = (className = '/Script/FactoryDedicatedServer.FGServerSettings') =>
  Buffer.concat([
    Buffer.from('GVAS'),
    u32(3),
    u32(522),
    u32(1017),
    u16(5),
    u16(6),
    u16(1),
    u32(0x80000000 + 513885),
    str('++FactoryGame+rel-main-anniversary-2026'),
    u32(3),
    u32(79),
    Buffer.alloc(79 * 20),
    str(className),
    Buffer.from([0]),
  ]);
const base = (): Buffer[] => [
  property('ServerName', str('Synthetic server')),
  property('ServerSecret', str('C'.repeat(512))),
];
const save = (fields: Buffer[] = base(), prefix: Buffer = header()) =>
  Buffer.concat([prefix, ...fields, str('None'), u32(0)]);

describe('native Satisfactory credential decoding', () => {
  it('reads the supported native profile without inferring omitted passwords or seeds', () => {
    expect(decodeSatisfactoryNativeCredentials(save())).toEqual({
      build: 513885,
      serverName: 'Synthetic server',
      serverSecret: 'C'.repeat(512),
    });
  });

  it('preserves exact hash/salt case and UTF16 server metadata with structural empty passwords', () => {
    const decoded = decodeSatisfactoryNativeCredentials(
      save([
        property('ServerName', str('Fabbrica 🏭', true)),
        base()[1] as Buffer,
        property('AdminPassword', password(), struct('FGStoredPasswordData')),
        property('ClientPassword', password('', ''), struct('FGStoredPasswordData')),
        property('AutoLoadSessionName', str('Sessione')),
        property(
          'APITokenSeed',
          Buffer.concat([u32(1), u32(2), u32(0xffffffff), u32(4)]),
          struct('Guid', '/Script/CoreUObject'),
          8,
        ),
      ]),
    );
    expect(decoded).toMatchObject({
      serverName: 'Fabbrica 🏭',
      autoLoadSessionName: 'Sessione',
      adminPassword: { hash: 'a'.repeat(128), salt: 'B'.repeat(64) },
      clientPassword: { hash: '', salt: '' },
      apiTokenSeed: [1, 2, 0xffffffff, 4],
    });
  });

  it('rejects unsupported class, save/package/engine/build versions and trailing bytes', () => {
    expect(
      decodeSatisfactoryNativeCredentials(save(base(), header('/Script/Other.Save'))),
    ).toBeUndefined();
    for (const offset of [0, 4, 8, 12, 16, 18, 20, 22]) {
      const bytes = save();
      bytes[offset] = (bytes[offset] ?? 0) ^ 1;
      expect(decodeSatisfactoryNativeCredentials(bytes)).toBeUndefined();
    }
    expect(
      decodeSatisfactoryNativeCredentials(Buffer.concat([save(), Buffer.from([0])])),
    ).toBeUndefined();
  });

  it('rejects every truncated prefix, oversized input and hostile lengths without throwing', () => {
    const bytes = save([
      ...base(),
      property('AdminPassword', password(), struct('FGStoredPasswordData')),
    ]);
    for (let length = 0; length < bytes.length; length++) {
      expect(decodeSatisfactoryNativeCredentials(bytes.subarray(0, length))).toBeUndefined();
    }
    expect(decodeSatisfactoryNativeCredentials(Buffer.alloc(256 * 1024 + 1))).toBeUndefined();
    const hostile = save();
    hostile.writeInt32LE(-0x80000000, header().length);
    expect(decodeSatisfactoryNativeCredentials(hostile)).toBeUndefined();
    const children = Buffer.concat([str('ServerName'), str('StrProperty'), u32(0xffffffff)]);
    expect(decodeSatisfactoryNativeCredentials(save([children]))).toBeUndefined();
  });

  it('rejects duplicate root/security fields, mismatched nested types and absent nested password members', () => {
    expect(
      decodeSatisfactoryNativeCredentials(save([...base(), base()[1] as Buffer])),
    ).toBeUndefined();
    const duplicate = Buffer.concat([
      password().subarray(0, -str('None').length),
      property('PasswordHash', str('d'.repeat(128))),
      str('None'),
    ]);
    for (const body of [
      duplicate,
      Buffer.concat([property('PasswordHash', str('a'.repeat(128))), str('None')]),
    ]) {
      expect(
        decodeSatisfactoryNativeCredentials(
          save([...base(), property('AdminPassword', body, struct('FGStoredPasswordData'))]),
        ),
      ).toBeUndefined();
    }
    expect(
      decodeSatisfactoryNativeCredentials(
        save([...base(), property('AdminPassword', password(), struct('OtherPassword'))]),
      ),
    ).toBeUndefined();
    expect(
      decodeSatisfactoryNativeCredentials(
        save([...base(), property('UnknownSecuritySetting', str('value'))]),
      ),
    ).toBeUndefined();
  });

  it('rejects invalid or partial credentials, embedded terminators, malformed UTF16 and tag flags', () => {
    for (const body of [
      password('', 'B'.repeat(64)),
      password('g'.repeat(128)),
      password('a'.repeat(127)),
    ]) {
      expect(
        decodeSatisfactoryNativeCredentials(
          save([...base(), property('AdminPassword', body, struct('FGStoredPasswordData'))]),
        ),
      ).toBeUndefined();
    }
    for (const value of [
      str('name\0suffix'),
      Buffer.from([0xfe, 0xff, 0xff, 0xff, 0x00, 0xd8, 0x00, 0x00]),
      Buffer.concat([u32(3), Buffer.from('abc')]),
    ]) {
      expect(
        decodeSatisfactoryNativeCredentials(
          save([property('ServerName', value), base()[1] as Buffer]),
        ),
      ).toBeUndefined();
    }
    expect(
      decodeSatisfactoryNativeCredentials(
        save([property('ServerName', str('name'), 'StrProperty', 8), base()[1] as Buffer]),
      ),
    ).toBeUndefined();
    expect(decodeSatisfactoryNativeCredentials(save([base()[0] as Buffer]))).toBeUndefined();
  });
});
