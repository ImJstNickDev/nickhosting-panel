import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readNativeBytes } from './native-response.js';
import {
  type OpenworldCheckpointAction,
  type OpenworldMapWorld,
  openworldCheckpointSchema,
  openworldMapWorldKey,
} from './world-map.js';

type Native = { origin: string; token: string; signal: AbortSignal; fetcher: typeof fetch };
const worldsSchema = z.object({
  worlds: z
    .array(
      z.object({
        key: openworldMapWorldKey,
        name: z.string().max(256).nullish(),
        faceEdgeMeters: z.number().positive().max(0x7fffffff).nullish(),
      }),
    )
    .max(256),
});
const checkpointsSchema = z.object({ checkpoints: z.array(openworldCheckpointSchema).max(8192) });
const deleted = z.object({ ok: z.literal(true) });

async function readJson(response: Response, limit: number): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readNativeBytes(response, limit)));
}

async function getNativeJson(native: Native, path: 'chunks' | 'checkpoints', world?: string) {
  const url = new URL(`/api/live/${path}`, native.origin);
  if (world !== undefined) url.searchParams.set('world', world);
  try {
    const response = await native.fetcher(url, {
      headers: { accept: 'application/json', 'X-OW-Token': native.token },
      redirect: 'error',
      signal: native.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new OpenworldTokenExpired();
      if (response.status === 404) throw new DomainError('game_request_unsupported');
      if (response.status === 503) throw new DomainError('game_not_ready');
      throw new DomainError('integration_unavailable');
    }
    return await readJson(response, path === 'chunks' ? 256 * 1024 : 4 * 1024 * 1024);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}

export async function readOpenworldMapWorlds(native: Native): Promise<OpenworldMapWorld[]> {
  const result = worldsSchema.safeParse(await getNativeJson(native, 'chunks'));
  if (!result.success) throw new DomainError('integration_unavailable');
  // The game includes its ship scene in chunk telemetry. It has no planetary coordinates.
  return result.data.worlds
    .filter((w) => w.key !== 'ships')
    .map((w) => ({
      key: w.key,
      name: w.name || w.key,
      faceEdgeMeters: w.faceEdgeMeters ?? null,
    }));
}

export async function readOpenworldCheckpoints(native: Native, world: string) {
  if (!openworldMapWorldKey.safeParse(world).success) throw new DomainError('validation_failed');
  const result = checkpointsSchema.safeParse(await getNativeJson(native, 'checkpoints', world));
  if (!result.success) throw new DomainError('integration_unavailable');
  return result.data.checkpoints.filter((entry) => entry.world === world);
}

export async function dispatchOpenworldCheckpoint(
  native: Native,
  world: string,
  action: OpenworldCheckpointAction,
) {
  const path = {
    create: 'checkpoints',
    update: 'checkpoints/update',
    delete: 'checkpoints/delete',
  }[action.kind];
  const url = new URL(`/api/live/${path}`, native.origin);
  const body: Record<string, unknown> = action.kind === 'create' ? {} : { id: action.id };
  if (action.kind !== 'delete') {
    Object.assign(body, action.fields);
    if (action.position) {
      const { type, ...coordinates } = action.position;
      Object.assign(body, { world }, coordinates);
    }
  }
  native.signal.throwIfAborted();
  try {
    const response = await native.fetcher(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-OW-Token': native.token,
      },
      signal: native.signal,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new OpenworldTokenExpired();
      if (response.status === 403) throw new DomainError('game_authentication_failed');
      if (response.status === 404)
        throw new DomainError(action.kind === 'create' ? 'game_request_unsupported' : 'not_found');
      if ([400, 409, 422].includes(response.status)) throw new DomainError('game_request_rejected');
      throw new DomainError('operation_uncertain');
    }
    const value = await readJson(response, 16_384);
    if (action.kind === 'delete') {
      if (!deleted.safeParse(value).success) throw new DomainError('operation_uncertain');
      return;
    }
    const checkpoint = openworldCheckpointSchema.safeParse(value);
    if (
      !checkpoint.success ||
      checkpoint.data.world !== world ||
      (action.kind === 'update' && checkpoint.data.id !== action.id)
    ) {
      throw new DomainError('operation_uncertain');
    }
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.code !== 'integration_unavailable' || error instanceof OpenworldTokenExpired)
    )
      throw error;
    throw new DomainError('operation_uncertain');
  }
}
