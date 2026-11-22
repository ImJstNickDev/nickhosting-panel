import { useState } from 'react';
import type { OpenworldTelemetryData } from '../../../../../games/openworld/src/telemetry.js';
import { useT } from '../../app/i18n.js';
import { playersBase } from './player-workspace.js';
import { base, key, numeric, useMetricsFormat } from './telemetry.js';

export type Player = OpenworldTelemetryData['players']['players'][number];
export type Connection = { id: number; name: string; joinedAt: number | null; processRef?: string };
export type Profile = { name: string; account: string | null; connection: Connection | null };
export const people = (key: string) => `games.openworld.people.${key}`;
export function verifiedAccount(p: { account?: string | null; accountVerified?: boolean | null }) {
  return p.accountVerified === true && p.account && /^[a-zA-Z0-9_-]{1,128}$/.test(p.account)
    ? p.account
    : null;
}
export function connection(
  p: Pick<Player, 'id' | 'name' | 'connectedS'>,
  stamp: string | null,
  processRef?: string,
): Connection {
  const time = stamp ? Date.parse(stamp) : NaN;
  return {
    id: p.id,
    name: p.name,
    ...(processRef ? { processRef } : {}),
    joinedAt:
      numeric(p.connectedS) && Number.isFinite(time)
        ? Math.round(time - p.connectedS * 1000)
        : null,
  };
}
export function playerParams(p: Connection) {
  const params = new URLSearchParams({ name: p.name });
  if (p.joinedAt !== null) params.set('joinedAt', String(p.joinedAt));
  return params;
}
export function samePlayer(a: Connection, b: Connection) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.processRef === b.processRef &&
    (a.joinedAt === null || b.joinedAt === null || Math.abs(a.joinedAt - b.joinedAt) <= 5000)
  );
}
export function PlayerArt({
  serverId,
  name,
  session,
  hash,
  savedSkin,
  body = false,
}: {
  serverId: string;
  name: string;
  session?: Connection | null;
  hash?: string | null;
  savedSkin?: { account: string; hash?: string | null };
  body?: boolean;
}) {
  const [failedLive, setFailedLive] = useState('');
  const [failedSave, setFailedSave] = useState('');
  // The game reports elapsed whole seconds, so successive estimates of joinedAt drift.
  // Pin the first confirmed timestamp for the image URL until the actual session changes.
  const [previous, setPrevious] = useState(session ?? null);
  const pinned =
    session &&
    previous &&
    (previous.joinedAt !== null || session.joinedAt === null) &&
    samePlayer(previous, session)
      ? previous
      : (session ?? null);
  if (pinned !== previous) setPrevious(pinned);
  const query = pinned ? playerParams(pinned) : null;
  if (query && hash) {
    query.set('view', body ? 'body' : 'head');
    query.set('h', hash);
  }
  const liveUrl =
    query && hash && pinned ? `${base(serverId)}/players/${pinned.id}/skin?${query}` : null;
  const revision = savedSkin?.hash;
  const savedUrl =
    savedSkin && revision
      ? `${playersBase(serverId)}/players/saved/${encodeURIComponent(savedSkin.account)}/skin?${new URLSearchParams({ view: body ? 'body' : 'head', h: revision })}`
      : null;
  const url =
    liveUrl && liveUrl !== failedLive ? liveUrl : savedUrl !== failedSave ? savedUrl : null;
  return (
    <span aria-hidden="true" className={body && url ? 'ow-body-skin' : 'ow-avatar'}>
      {url ? (
        <img
          alt=""
          loading="lazy"
          decoding="async"
          src={url}
          onError={() => (url === liveUrl ? setFailedLive(url) : setFailedSave(url))}
        />
      ) : (
        Array.from(name.trim())[0]?.toLocaleUpperCase() || '·'
      )}
    </span>
  );
}
export function usePlayerFormat() {
  const t = useT(),
    f = useMetricsFormat();
  const stamp = (value: string | number | null | undefined) => {
    if (value == null) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? f.date(date) : '—';
  };
  const mode = (value?: string | null) =>
    value && ['survival', 'creative', 'spectre', 'spectator'].includes(value)
      ? t(key(value === 'spectator' ? 'spectre' : value))
      : value || '—';
  return { ...f, stamp, mode };
}
