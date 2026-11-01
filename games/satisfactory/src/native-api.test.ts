import { createHash } from 'node:crypto';
import type { GatewayOfflineApiRequest } from '@nickhosting/game-sdk';
import { describe, expect, it, vi } from 'vitest';
import { handleNativeOfflineApi, supportsNativeOfflineOperation } from './native-api.js';
import {
  createNativeAuthenticationToken,
  decodeNativePlayerIdentity,
  nativeAuthenticationFingerprint,
  verifyNativeAuthenticationToken,
} from './native-auth.js';
import type { NativeSatisfactoryCredentials } from './native-credentials.js';

const password = (text: string, salt: string) => ({
  salt,
  hash: createHash('sha512')
    .update(Buffer.from(salt, 'hex'))
    .update(text, 'utf8')
    .digest('hex')
    .toUpperCase(),
});
const credentials: NativeSatisfactoryCredentials = {
  build: 513885,
  serverName: 'Synthetic',
  serverSecret: '01'.repeat(256),
  adminPassword: password('admin-fixture', '02'.repeat(32)),
  clientPassword: password('client-fixture', '03'.repeat(32)),
};
const playerId = '060102030405060708';
const player = decodeNativePlayerIdentity(playerId);
if (!player) throw new Error('fixture');
const token = (source = credentials, privilege: 'Client' | 'Administrator' = 'Client') =>
  createNativeAuthenticationToken(source, privilege, player);
const request = (operation: string, data?: Record<string, unknown>): GatewayOfflineApiRequest => ({
  operation,
  playerId,
  ...(data ? { data } : {}),
});
const snapshot = {
  data: {
    serverGameState: {
      activeSessionName: 'Observed world',
      numConnectedPlayers: 0,
      isGameRunning: true,
    },
  },
};

describe('native offline API authentication', () => {
  it('returns only the native authenticationToken envelope for a correct password and honors native admin elevation', () => {
    const reader = vi.fn();
    for (const [text, minimum, privilege] of [
      ['client-fixture', 'Client', 'Client'],
      ['admin-fixture', 'Client', 'Administrator'],
      ['admin-fixture', 'Administrator', 'Administrator'],
    ] as const) {
      const result = handleNativeOfflineApi(
        credentials,
        request('PasswordLogin', { Password: text, MinimumPrivilegeLevel: minimum }),
        reader,
      );
      expect(result).toEqual({
        status: 200,
        body: { data: { authenticationToken: token(credentials, privilege) } },
      });
      expect(
        verifyNativeAuthenticationToken(
          credentials,
          token(credentials, privilege),
          minimum,
          player,
        ),
      ).toBe(privilege);
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects wrong passwords and client-to-admin escalation without consulting backend snapshots', () => {
    const reader = vi.fn(() => snapshot);
    for (const [text, minimum] of [
      ['wrong', 'Client'],
      ['', 'Client'],
      ['client-fixture', 'Administrator'],
    ] as const) {
      expect(
        handleNativeOfflineApi(
          credentials,
          request('PasswordLogin', { Password: text, MinimumPrivilegeLevel: minimum }),
          reader,
        ),
      ).toEqual({ status: 200, body: { errorCode: 'wrong_password' } });
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it('allows passwordless client access only for a claimed server with native empty client credentials', () => {
    const { clientPassword: _omitted, ...open } = credentials;
    expect(
      handleNativeOfflineApi(
        open,
        request('PasswordlessLogin', { minimumPrivilegeLevel: 'Client' }),
        vi.fn(),
      ),
    ).toEqual({ status: 200, body: { data: { authenticationToken: token(open) } } });
    for (const [source, minimum] of [
      [credentials, 'Client'],
      [open, 'Administrator'],
    ] as const) {
      expect(
        handleNativeOfflineApi(
          source,
          request('PasswordlessLogin', { minimumPrivilegeLevel: minimum }),
          vi.fn(),
        ),
      ).toEqual({ status: 200, body: { errorCode: 'passwordless_login_not_possible' } });
    }
  });

  it('verifies raw native fingerprints with exact 204 schema and no Authorization-header fallback', () => {
    const fingerprint = nativeAuthenticationFingerprint(credentials, 'Client', player);
    const verify = request('VerifyAuthenticationToken', {
      authenticationToken: fingerprint,
      privilegeLevel: 'Client',
    });
    expect(handleNativeOfflineApi(credentials, verify, vi.fn())).toEqual({ status: 204 });
    expect(
      handleNativeOfflineApi(credentials, { ...verify, authorization: 'Bearer invalid' }, vi.fn()),
    ).toEqual({ status: 204 });
    expect(
      handleNativeOfflineApi(
        credentials,
        { ...verify, data: { privilegeLevel: 'Client' }, authorization: `Bearer ${token()}` },
        vi.fn(),
      ),
    ).toEqual({ status: 200, body: { errorCode: 'missing_params' } });
    expect(
      handleNativeOfflineApi(
        credentials,
        request('VerifyAuthenticationToken', {
          authenticationToken: token(),
          privilegeLevel: 'Client',
        }),
        vi.fn(),
      ),
    ).toEqual({ status: 401, body: { errorCode: 'token_validation_failed' } });
  });

  it('rejects fingerprints bound to another player/privilege and revokes them after credential changes', () => {
    const fingerprint = nativeAuthenticationFingerprint(credentials, 'Client', player);
    const verify = request('VerifyAuthenticationToken', {
      authenticationToken: fingerprint,
      privilegeLevel: 'Client',
    });
    for (const changed of [
      { ...verify, playerId: '060102030405060709' },
      { ...verify, data: { authenticationToken: fingerprint, privilegeLevel: 'Administrator' } },
      {
        ...verify,
        data: {
          authenticationToken: `${fingerprint.slice(0, -1)}${fingerprint.endsWith('0') ? '1' : '0'}`,
          privilegeLevel: 'Client',
        },
      },
    ]) {
      expect(handleNativeOfflineApi(credentials, changed, vi.fn())).toEqual({
        status: 401,
        body: { errorCode: 'token_validation_failed' },
      });
    }
    const changed = { ...credentials, clientPassword: password('replacement', '04'.repeat(32)) };
    expect(handleNativeOfflineApi(changed, verify, vi.fn())).toEqual({
      status: 401,
      body: { errorCode: 'token_validation_failed' },
    });
  });

  it('serves only observed protected snapshots after independent native bearer verification', () => {
    for (const operation of ['QueryServerState', 'GetServerOptions', 'GetAdvancedGameSettings']) {
      const read = vi.fn(() => snapshot);
      expect(
        handleNativeOfflineApi(
          credentials,
          { ...request(operation), authorization: `Bearer ${token()}` },
          read,
        ),
      ).toEqual({ status: 200, body: snapshot });
      expect(read).toHaveBeenCalledExactlyOnceWith(operation);
      for (const authorization of [
        undefined,
        'Bearer invalid',
        `Bearer ${token().slice(0, -2)}00`,
      ]) {
        read.mockClear();
        expect(
          handleNativeOfflineApi(credentials, { ...request(operation), authorization }, read),
        ).toEqual({ status: 401, body: { errorCode: 'invalid_token' } });
        expect(read).not.toHaveBeenCalled();
      }
    }
  });

  it('never borrows another player authorization, stale-password token, or invents missing observations', () => {
    const read = vi.fn(() => snapshot);
    const authorized = { ...request('QueryServerState'), authorization: `Bearer ${token()}` };
    expect(
      handleNativeOfflineApi(credentials, { ...authorized, playerId: '060102030405060709' }, read),
    ).toEqual({ status: 401, body: { errorCode: 'invalid_token' } });
    expect(
      handleNativeOfflineApi(
        { ...credentials, clientPassword: password('replacement', '04'.repeat(32)) },
        authorized,
        read,
      ),
    ).toEqual({ status: 401, body: { errorCode: 'invalid_token' } });
    expect(read).not.toHaveBeenCalled();
    expect(handleNativeOfflineApi(credentials, authorized, () => undefined)).toEqual({
      status: 503,
      body: { errorCode: 'server_unavailable' },
    });
  });

  it('fails closed for unknown native profiles or unclaimed servers instead of minting login tokens', () => {
    const login = request('PasswordlessLogin', { minimumPrivilegeLevel: 'Client' });
    const { adminPassword: _omitted, ...unclaimed } = credentials;
    expect(handleNativeOfflineApi(unclaimed, login, vi.fn())).toEqual({
      status: 503,
      body: { errorCode: 'server_not_claimed' },
    });
    for (const source of [
      { ...credentials, build: 1 },
      { ...credentials, serverSecret: 'unknown' },
      { ...credentials, adminPassword: { hash: 'invalid', salt: '' } },
    ]) {
      expect(handleNativeOfflineApi(source, login, vi.fn())).toEqual({
        status: 503,
        body: { errorCode: 'server_unavailable' },
      });
    }
  });

  it('rejects malformed or ambiguous parameters and unknown player registry encodings', () => {
    expect(
      handleNativeOfflineApi(
        credentials,
        request('PasswordLogin', {
          Password: 'admin-fixture',
          password: 'different',
          MinimumPrivilegeLevel: 'Administrator',
        }),
        vi.fn(),
      ),
    ).toEqual({ status: 400, body: { errorCode: 'bad_request' } });
    for (const id of ['', '00', '060000000000000000', `07${'01'.repeat(8)}`]) {
      expect(
        handleNativeOfflineApi(credentials, { ...request('PasswordLogin'), playerId: id }, vi.fn()),
      ).toEqual({ status: 400, body: { errorCode: 'invalid_player_id' } });
    }
    for (const data of [
      {},
      { MinimumPrivilegeLevel: 'Administrator' },
      { MinimumPrivilegeLevel: 'Owner', Password: 'admin-fixture' },
    ]) {
      expect(handleNativeOfflineApi(credentials, request('PasswordLogin', data), vi.fn())).toEqual({
        status: 200,
        body: { errorCode: 'missing_params' },
      });
    }
  });

  it('never claims support for joining, claiming, commands or mutation APIs', () => {
    for (const operation of [
      'JoinGameRequest',
      'ClaimServer',
      'RunCommand',
      'ApplyServerOptions',
      'Shutdown',
    ]) {
      expect(supportsNativeOfflineOperation(operation)).toBe(false);
      const read = vi.fn(() => snapshot);
      expect(
        handleNativeOfflineApi(
          credentials,
          { ...request(operation), authorization: `Bearer ${token(credentials, 'Administrator')}` },
          read,
        ),
      ).toEqual({ status: 404, body: { errorCode: 'not_found' } });
      expect(read).not.toHaveBeenCalled();
    }
  });
});
