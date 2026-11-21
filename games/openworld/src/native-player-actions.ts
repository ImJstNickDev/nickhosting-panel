import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { OpenworldTokenExpired, readOpenworldTelemetry } from './dashboard-api.js';
import { readNativeBytes } from './native-response.js';
import type {
  OpenworldActionPlayer,
  OpenworldPlayerAction,
  OpenworldTeleportDestinations,
} from './player-actions.js';

type Native = { origin: string; token: string; signal: AbortSignal; fetcher: typeof fetch };
const checkpoints = z.object({
  checkpoints: z
    .array(
      z.object({
        id: z.number().int().nonnegative().max(0xffffffff),
        name: z.string().min(1).max(256),
        world: z.string().min(1).max(128),
      }),
    )
    .max(8192),
});

async function readCheckpoints(native: Native) {
  const { origin, token, signal, fetcher } = native;
  try {
    const res = await fetcher(new URL('/api/live/checkpoints', origin), {
      redirect: 'error',
      headers: { accept: 'application/json', 'X-OW-Token': token },
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) throw new OpenworldTokenExpired();
      throw new DomainError('integration_unavailable');
    }
    return checkpoints.parse(
      JSON.parse(new TextDecoder().decode(await readNativeBytes(res, 2 * 1024 * 1024))),
    ).checkpoints;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}

async function readWorlds({ origin, token, signal, fetcher }: Native) {
  const { worlds } = await readOpenworldTelemetry(
    origin,
    token,
    'chunks',
    signal,
    undefined,
    fetcher,
  );
  return worlds.map(({ key, name }) => ({ key, name: name || key }));
}

export async function readOpenworldDestinations(
  native: Native,
): Promise<OpenworldTeleportDestinations> {
  const [worlds, checkpoints] = await Promise.all([readWorlds(native), readCheckpoints(native)]);
  return { worlds, checkpoints };
}

export async function prepareOpenworldPlayerAction(
  native: Native,
  selected: OpenworldActionPlayer,
  action: OpenworldPlayerAction,
  now: () => number,
) {
  const dest = action.kind === 'teleport' ? action.destination : undefined;
  if (dest?.type === 'checkpoint' && !(await readCheckpoints(native)).some((c) => c.id === dest.id))
    throw new DomainError('not_found');
  if (dest?.type === 'coordinates' && !(await readWorlds(native)).some((w) => w.key === dest.world))
    throw new DomainError('not_found');
  if (dest?.type === 'player' && dest.player.id === selected.id)
    throw new DomainError('validation_failed');

  // Connection numbers are process-local. Always fetch a new roster before a write,
  // and use the same observation to validate the source and the teleport target.
  const { players } = await readOpenworldTelemetry(
    native.origin,
    native.token,
    'players',
    native.signal,
    undefined,
    native.fetcher,
  );
  const observedAt = now();
  for (const expected of dest?.type === 'player' ? [selected, dest.player] : [selected]) {
    const match = players.find((p) => p.id === expected.id);
    // connectedS is rounded by some releases. Fail closed on unknown session age.
    if (
      !match ||
      match.name !== expected.name ||
      match.connectedS == null ||
      match.connectedS < 0 ||
      Math.abs(observedAt - match.connectedS * 1000 - expected.joinedAt) > 1500
    )
      throw new DomainError('conflict');
  }
}

function nativeBody(id: number, action: OpenworldPlayerAction) {
  switch (action.kind) {
    case 'teleport': {
      const d = action.destination;
      if (d.type === 'coordinates')
        return { id, world: d.world, lat: d.lat, lon: d.lon, alt: d.alt ?? null };
      if (d.type === 'player') return { id, toPlayer: d.player.id };
      return { id, toCheckpoint: d.id };
    }
    case 'message':
      return { id, text: action.text };
    case 'gamemode':
      return { id, mode: action.mode };
    case 'kick':
      return { id, reason: action.reason ?? '' };
    default:
      return { id };
  }
}

export async function dispatchOpenworldPlayerAction(
  { origin, token, signal, fetcher }: Native,
  id: number,
  action: OpenworldPlayerAction,
) {
  const url = new URL(`/api/live/player/${action.kind}`, origin);
  signal.throwIfAborted();
  try {
    const res = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-OW-Token': token,
      },
      body: JSON.stringify(nativeBody(id, action)),
    });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401) throw new OpenworldTokenExpired();
      if (res.status === 403) throw new DomainError('game_authentication_failed');
      if (res.status === 404) throw new DomainError('game_request_unsupported');
      if (res.status === 400 || res.status === 409 || res.status === 422)
        throw new DomainError('game_request_rejected');
      throw new DomainError('operation_uncertain');
    }
    const bytes = await readNativeBytes(res, 16_384);
    const result = z
      .object({ ok: z.boolean() })
      .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!result.success) throw new DomainError('operation_uncertain');
    if (!result.data.ok) throw new DomainError('game_request_rejected');
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.code !== 'integration_unavailable' || error instanceof OpenworldTokenExpired)
    )
      throw error;
    // An interruption after dispatch cannot establish whether the game applied it.
    throw new DomainError('operation_uncertain');
  }
}
