import { timingSafeEqual } from 'node:crypto';
import type { GatewayOfflineApiRequest, GatewayOfflineApiResponse } from '@nickhosting/game-sdk';
import {
  createNativeAuthenticationToken,
  decodeNativePlayerIdentity,
  type NativePlayerPrivilege,
  nativeAuthenticationFingerprint,
  nativePasswordMatches,
  verifyNativeAuthenticationToken,
} from './native-auth.js';
import type { NativeSatisfactoryCredentials } from './native-credentials.js';

const operations = new Set([
  'PasswordlessLogin',
  'PasswordLogin',
  'VerifyAuthenticationToken',
  'QueryServerState',
  'GetServerOptions',
  'GetAdvancedGameSettings',
  'EnumerateSessions',
]);
export function supportsNativeOfflineOperation(operation: string): boolean {
  return operations.has(operation);
}
function failure(errorCode: string, status = 200): GatewayOfflineApiResponse {
  return { status, body: { errorCode } };
}
function parameters(data: GatewayOfflineApiRequest['data']): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(data ?? {})) {
    const lower = key.toLowerCase();
    if (Object.hasOwn(result, lower)) return undefined;
    result[lower] = value;
  }
  return result;
}
function playerPrivilege(value: unknown): value is NativePlayerPrivilege {
  return value === 'Client' || value === 'Administrator';
}
/** Call only with freshly read credentials from a confirmed stopped instance.
 * Native authentication is computed, never inferred from a cached API success.
 * Read responses must come from actual backend observations supplied by Core. */
export function handleNativeOfflineApi(
  credentials: NativeSatisfactoryCredentials,
  request: GatewayOfflineApiRequest,
  readSnapshot: (operation: string) => Record<string, unknown> | undefined,
): GatewayOfflineApiResponse {
  if (!supportsNativeOfflineOperation(request.operation)) return failure('not_found', 404);
  if (
    credentials.build !== 513885 ||
    !/^[a-f\d]{512}$/i.test(credentials.serverSecret) ||
    [credentials.adminPassword, credentials.clientPassword].some(
      (password) =>
        password &&
        !(
          (password.hash === '' && password.salt === '') ||
          (/^[a-f\d]{128}$/i.test(password.hash) && /^[a-f\d]{64}$/i.test(password.salt))
        ),
    )
  )
    return failure('server_unavailable', 503);
  const player = decodeNativePlayerIdentity(request.playerId);
  if (!player) return failure('invalid_player_id', 400);
  const data = parameters(request.data);
  if (!data) return failure('bad_request', 400);
  // Claiming and privileged setup require the running server's real effects.
  if (!credentials.adminPassword?.hash) return failure('server_not_claimed', 503);
  if (request.operation === 'VerifyAuthenticationToken') {
    const fingerprint = data.authenticationtoken;
    const privilege = data.privilegelevel;
    if (typeof fingerprint !== 'string' || !playerPrivilege(privilege))
      return failure('missing_params');
    if (!/^[a-f\d]{128}$/i.test(fingerprint)) return failure('token_validation_failed', 401);
    const expected = nativeAuthenticationFingerprint(credentials, privilege, player);
    return timingSafeEqual(Buffer.from(fingerprint, 'hex'), Buffer.from(expected, 'hex'))
      ? { status: 204 }
      : failure('token_validation_failed', 401);
  }
  if (request.operation === 'PasswordlessLogin' || request.operation === 'PasswordLogin') {
    const minimum = data.minimumprivilegelevel;
    if (!playerPrivilege(minimum)) return failure('missing_params');
    let privilege: NativePlayerPrivilege | undefined;
    if (request.operation === 'PasswordlessLogin') {
      if (minimum === 'Client' && !credentials.clientPassword?.hash) privilege = 'Client';
      if (!privilege) return failure('passwordless_login_not_possible');
    } else {
      if (typeof data.password !== 'string') return failure('missing_params');
      if (nativePasswordMatches(credentials.adminPassword, data.password))
        privilege = 'Administrator';
      else if (
        minimum === 'Client' &&
        nativePasswordMatches(credentials.clientPassword, data.password)
      )
        privilege = 'Client';
      if (!privilege) return failure('wrong_password');
    }
    return {
      status: 200,
      body: {
        data: {
          authenticationToken: createNativeAuthenticationToken(credentials, privilege, player),
        },
      },
    };
  }
  const authorization = request.authorization;
  const privilege = authorization?.startsWith('Bearer ')
    ? verifyNativeAuthenticationToken(credentials, authorization.slice(7), 'Client', player)
    : undefined;
  if (!privilege) return failure('invalid_token', 401);
  // The native save controller requires Administrator even though enumeration
  // is read-only. Validate the token before checking scope, without consulting
  // historical observations for either authentication or authorization.
  if (request.operation === 'EnumerateSessions' && privilege !== 'Administrator')
    return failure('insufficient_scope', 403);
  const snapshot = readSnapshot(request.operation);
  return snapshot ? { status: 200, body: snapshot } : failure('server_unavailable', 503);
}
