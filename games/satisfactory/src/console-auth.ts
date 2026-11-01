import type { GatewayOfflineApiRequest } from '@nickhosting/game-sdk';
import { decodeNativePlayerIdentity, verifyNativeAuthenticationToken } from './native-auth.js';
import type { NativeSatisfactoryCredentials } from './native-credentials.js';

/** Syntax only: online callers MUST verify the fingerprint with the backend. */
export function consoleAdministratorIdentity(request: GatewayOfflineApiRequest) {
  const player = decodeNativePlayerIdentity(request.playerId);
  if (!player) return undefined;
  const playerId = player.provider === 0 ? 'INVALID' : (request.playerId as string);
  const match = /^Bearer ([A-Za-z\d+/]+={0,2})\.([a-f\d]{128})$/i.exec(request.authorization ?? '');
  if (!match || !request.authorization?.startsWith('Bearer ')) return undefined;
  const payload = match[1] as string;
  try {
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, ''))
      return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !('pl' in parsed) ||
      parsed.pl !== 'Administrator'
    )
      return undefined;
    return {
      token: request.authorization.slice(7),
      fingerprint: match[2] as string,
      playerId,
    };
  } catch {
    return undefined;
  }
}

/** Only fresh credentials from a physically stopped managed instance may be used. */
export function authorizeStoppedConsoleAdministrator(
  credentials: NativeSatisfactoryCredentials,
  request: GatewayOfflineApiRequest,
): boolean {
  const identity = consoleAdministratorIdentity(request);
  const player = decodeNativePlayerIdentity(identity?.playerId);
  if (
    !identity ||
    !player ||
    credentials.build !== 513885 ||
    !/^[a-f\d]{512}$/i.test(credentials.serverSecret) ||
    !/^[a-f\d]{128}$/i.test(credentials.adminPassword?.hash ?? '') ||
    !/^[a-f\d]{64}$/i.test(credentials.adminPassword?.salt ?? '')
  )
    return false;
  return (
    verifyNativeAuthenticationToken(credentials, identity.token, 'Administrator', player) ===
    'Administrator'
  );
}
