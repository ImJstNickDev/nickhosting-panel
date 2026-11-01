import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createNativeAuthenticationToken,
  decodeNativePlayerIdentity,
  nativeAuthenticationFingerprint,
  nativePasswordMatches,
  verifyNativeAuthenticationToken,
} from './native-auth.js';
import type { NativeSatisfactoryCredentials } from './native-credentials.js';

// Entirely synthetic. The known answers were independently calculated using
// Python hmac/hashlib over the explicitly serialized bytes below.
const credentials: NativeSatisfactoryCredentials = {
  build: 513885,
  serverName: 'Synthetic auth fixture',
  serverSecret: '01'.repeat(256),
  adminPassword: { hash: 'A'.repeat(128), salt: 'B'.repeat(64) },
  clientPassword: { hash: 'C'.repeat(128), salt: 'D'.repeat(64) },
};
const player = { provider: 1, replicationData: Uint8Array.of(1, 2, 3) };
const knownFingerprint =
  'FC45954D7B4C5B13F80211878D5633B01EF3AF0BCB883BD5D654059E68BFF73924577625EF647E4550AD9DCA66DDBE137EF1F39A8CB33AB9E8E7D4A0A9AF73B5';
const payload = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

describe('native persistent authentication compatibility', () => {
  it('decodes proven Steam and Epic registry bytes without normalizing Epic identifiers', () => {
    const steam = decodeNativePlayerIdentity('060110000100000001');
    expect(steam).toEqual({ provider: 6, replicationData: Buffer.from('0110000100000001', 'hex') });
    const lower = 'abcdef0123456789'.repeat(2),
      upper = lower.toUpperCase();
    const epic = (id: string) => `01${Buffer.from(id).toString('hex')}`;
    expect(decodeNativePlayerIdentity(epic(lower))).toEqual({
      provider: 1,
      replicationData: Buffer.from(lower),
    });
    expect(decodeNativePlayerIdentity(epic(lower).toUpperCase())).toEqual(
      decodeNativePlayerIdentity(epic(lower)),
    );
    expect(decodeNativePlayerIdentity(epic(upper))).not.toEqual(
      decodeNativePlayerIdentity(epic(lower)),
    );
    for (const input of [
      '',
      '060000000000000000',
      '06ab',
      epic('z'.repeat(32)),
      `01${'ff'.repeat(32)}`,
      `02${'ab'.repeat(32)}`,
    ])
      expect(decodeNativePlayerIdentity(input)).toBeUndefined();
    expect(decodeNativePlayerIdentity('invalid')).toEqual(decodeNativePlayerIdentity(undefined));
  });
  it('matches independent HMAC bytes: provider, array length/data, privilege, FString hash', () => {
    const serialized = Buffer.concat([
      Buffer.from('01030000000102030381000000', 'hex'),
      Buffer.alloc(128, 0x41),
      Buffer.from([0]),
    ]);
    expect(
      createHmac('sha512', Buffer.alloc(256, 1)).update(serialized).digest('hex').toUpperCase(),
    ).toBe(knownFingerprint);
    expect(nativeAuthenticationFingerprint(credentials, 'Administrator', player)).toBe(
      knownFingerprint,
    );
    expect(createNativeAuthenticationToken(credentials, 'Administrator', player)).toBe(
      `${payload({ pl: 'Administrator' })}.${knownFingerprint}`,
    );
  });

  it('serializes absent native default hashes as zero-length FString and no-player data as an empty array', () => {
    const { clientPassword: _omitted, ...withoutClientPassword } = credentials;
    expect(
      nativeAuthenticationFingerprint(withoutClientPassword, 'Client', {
        provider: 0,
        replicationData: new Uint8Array(),
      }),
    ).toBe(
      '7C6ACAB4F0A3A34F86243D817C59544A33CBDABEC98E6DF83882660724A2B892A697CE38B0BFFCBAFE4EA7800A290F8C3727C02122A93A77A95583B4475C2480',
    );
    expect(
      nativeAuthenticationFingerprint(
        { ...withoutClientPassword, clientPassword: { hash: '', salt: '' } },
        'Client',
        player,
      ),
    ).toBe(nativeAuthenticationFingerprint(withoutClientPassword, 'Client', player));
  });

  it('matches native binary salt + UTF8 password hashing without normalizing Unicode or salt casing', () => {
    const hash =
      '73FB8820BBAE4F3E86E3B60ACA4B1667718D7517A739452A29C0AB79EFAB6D8B1438D550B9393448B0A3C9FEB4F1F6ADDE619DF31DE15A6FD5C4A1C9B02570DF';
    const stored = { hash, salt: 'AB'.repeat(32) };
    expect(nativePasswordMatches(stored, 'Pässw🔐rd')).toBe(true);
    expect(nativePasswordMatches({ ...stored, salt: stored.salt.toLowerCase() }, 'Pässw🔐rd')).toBe(
      true,
    );
    for (const password of ['', 'wrong', 'Pa\u0308ssw🔐rd', 'Pässw🔐rd\0', 'x'.repeat(4097)]) {
      expect(nativePasswordMatches(stored, password)).toBe(false);
    }
    expect(nativePasswordMatches({ ...stored, salt: 'AC'.repeat(32) }, 'Pässw🔐rd')).toBe(false);
    expect(nativePasswordMatches({ ...stored, salt: 'not-hex' }, 'Pässw🔐rd')).toBe(false);
    expect(nativePasswordMatches({ ...stored, hash: 'invalid' }, 'Pässw🔐rd')).toBe(false);
    expect(nativePasswordMatches(undefined, '')).toBe(true);
    expect(nativePasswordMatches(undefined, 'provided')).toBe(false);
    expect(nativePasswordMatches({ hash: '', salt: '' }, '')).toBe(true);
  });

  it('enforces minimum privilege and prevents payload privilege escalation and fingerprint tampering', () => {
    const client = createNativeAuthenticationToken(credentials, 'Client', player);
    const admin = createNativeAuthenticationToken(credentials, 'Administrator', player);
    expect(verifyNativeAuthenticationToken(credentials, client, 'Client', player)).toBe('Client');
    expect(verifyNativeAuthenticationToken(credentials, admin, 'Client', player)).toBe(
      'Administrator',
    );
    expect(verifyNativeAuthenticationToken(credentials, admin, 'Administrator', player)).toBe(
      'Administrator',
    );
    expect(
      verifyNativeAuthenticationToken(credentials, client, 'Administrator', player),
    ).toBeUndefined();
    expect(
      verifyNativeAuthenticationToken(
        credentials,
        `${payload({ pl: 'Administrator' })}.${client.split('.')[1]}`,
        'Client',
        player,
      ),
    ).toBeUndefined();
    expect(
      verifyNativeAuthenticationToken(credentials, `${admin.slice(0, -1)}0`, 'Client', player),
    ).toBeUndefined();
  });

  it('binds tokens to player provider/data, current secret and privilege-specific password hash', () => {
    const token = createNativeAuthenticationToken(credentials, 'Administrator', player);
    for (const other of [
      { ...player, provider: 2 },
      { ...player, replicationData: Uint8Array.of(1, 2, 4) },
      { ...player, replicationData: new Uint8Array() },
    ]) {
      expect(verifyNativeAuthenticationToken(credentials, token, 'Client', other)).toBeUndefined();
    }
    expect(
      verifyNativeAuthenticationToken(
        { ...credentials, serverSecret: '02'.repeat(256) },
        token,
        'Client',
        player,
      ),
    ).toBeUndefined();
    expect(
      verifyNativeAuthenticationToken(
        { ...credentials, adminPassword: { hash: 'E'.repeat(128), salt: 'B'.repeat(64) } },
        token,
        'Client',
        player,
      ),
    ).toBeUndefined();
    expect(
      verifyNativeAuthenticationToken(
        { ...credentials, clientPassword: { hash: 'E'.repeat(128), salt: 'D'.repeat(64) } },
        token,
        'Client',
        player,
      ),
    ).toBe('Administrator');
  });

  it('fails closed on malformed encodings, JSON shapes, unsupported privileges and oversized tokens', () => {
    const suffix = `.${knownFingerprint}`;
    const invalid = [
      '',
      'x'.repeat(8193),
      `${payload({ pl: 'Administrator' })}${suffix}.extra`,
      `%%%${suffix}`,
      `A${suffix}`,
      `AB${suffix}`,
      `e30====${suffix}`,
      `${Buffer.from('{invalid').toString('base64')}${suffix}`,
      `${Buffer.from([0xff]).toString('base64')}${suffix}`,
      ...[
        null,
        [],
        'Administrator',
        {},
        { pl: 'Client', ticket: 'invented' },
        { pl: 'Admin' },
        { pl: 'APIToken' },
        { pl: '__proto__' },
        { pl: 3 },
      ].map((value) => `${payload(value)}${suffix}`),
      `${payload({ pl: 'Administrator' })}.${'z'.repeat(128)}`,
      `${payload({ pl: 'Administrator' })}.${'0'.repeat(127)}`,
    ];
    for (const token of invalid)
      expect(verifyNativeAuthenticationToken(credentials, token, 'Client', player)).toBeUndefined();
  });

  it('rejects unknown builds, invalid credentials and invalid player serialization bounds', () => {
    const token = createNativeAuthenticationToken(credentials, 'Administrator', player);
    for (const invalid of [
      { ...credentials, build: 513886 },
      { ...credentials, serverSecret: 'g'.repeat(512) },
      { ...credentials, serverSecret: '01' },
    ]) {
      expect(() => nativeAuthenticationFingerprint(invalid, 'Administrator', player)).toThrow();
      expect(verifyNativeAuthenticationToken(invalid, token, 'Client', player)).toBeUndefined();
    }
    for (const invalid of [
      { ...player, provider: -1 },
      { ...player, provider: 256 },
      { ...player, provider: 1.5 },
      { ...player, replicationData: new Uint8Array(1025) },
    ]) {
      expect(() =>
        nativeAuthenticationFingerprint(credentials, 'Administrator', invalid),
      ).toThrow();
      expect(
        verifyNativeAuthenticationToken(credentials, token, 'Client', invalid),
      ).toBeUndefined();
    }
  });
});
