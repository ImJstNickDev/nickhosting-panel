import type { Connection, Profile } from './player-identity.js';

export const playersPath = (id: string) => `/servers/${encodeURIComponent(id)}/game/players`;

// Keep the native fingerprint in the fragment. A connection number alone is reused
// by the game after disconnects and process restarts.
export function playerPath(server: string, profile: Profile) {
  const session = profile.connection;
  const base = playersPath(server);
  const accountPath = profile.account ? `${base}/${encodeURIComponent(profile.account)}` : base;
  if (!session) return accountPath;
  const path = profile.account ? accountPath : `${base}/connection/${session.id}`;
  const hash = new URLSearchParams({ player: String(session.id), name: session.name });
  if (session.joinedAt !== null) hash.set('joinedAt', String(session.joinedAt));
  if (session.processRef) hash.set('processRef', session.processRef);
  return `${path}#${hash}`;
}

export function sessionFromFragment(hash: string): Connection | null {
  const params = new URLSearchParams(hash.slice(1));
  const player = params.get('player');
  const name = params.get('name');
  const start = params.get('joinedAt');
  const processRef = params.get('processRef');
  if (
    !player ||
    !/^\d{1,10}$/.test(player) ||
    Number(player) > 0xffffffff ||
    !name ||
    name.length > 256 ||
    (processRef !== null && !/^[a-f0-9]{64}$/.test(processRef)) ||
    (start !== null &&
      (!/^\d{1,16}$/.test(start) || !Number.isSafeInteger(Number(start)) || Number(start) <= 0))
  )
    return null;
  return {
    id: Number(player),
    name,
    joinedAt: start === null ? null : Number(start),
    ...(processRef ? { processRef } : {}),
  };
}

export function profileFromRoute(path: string, hash: string): Profile | null {
  const session = sessionFromFragment(hash);
  if (path.startsWith('connection/')) {
    if (!session || path !== `connection/${session.id}`) return null;
    return { connection: session, name: session.name, account: null };
  }
  if (!/^(?:guest:)?[A-Za-z0-9_-]{1,128}$/.test(path) || (hash && !session)) return null;
  return { connection: session, name: session?.name ?? path, account: path };
}
