import { z } from 'zod';

const value = z.number().nullish();
const flag = z.boolean().nullish();
const label = z.string().max(256);
const key = z.string().min(1).max(128);
const epochMilliseconds = z.number().nonnegative().max(8_640_000_000_000_000);

function measurements<const T extends string>(...names: T[]) {
  return Object.fromEntries(names.map((name) => [name, value])) as Record<T, typeof value>;
}

const status = z.object({
  tps: z.number().nonnegative(),
  players: z.object({
    online: z.number().int().nonnegative(),
    slots: z.number().int().positive(),
    connecting: value,
  }),
  ...measurements('t', 'tick', 'uptimeS', 'tickBudgetMs'),
  tickMs: z.object(measurements('mean', 'p99', 'max')).nullish(),
  phasesMs: z
    .object(
      measurements(
        'net',
        'chunks',
        'players',
        'edits',
        'sim',
        'snapshot',
        'projectiles',
        'entities',
        'chests',
        'send',
      ),
    )
    .nullish(),
  net: z
    .object(
      measurements(
        'connections',
        'sentKbps',
        'recvKbps',
        'lossPct',
        'acceptedTotal',
        'disconnectsTotal',
      ),
    )
    .nullish(),
  pingMs: z.object(measurements('mean', 'max')).nullish(),
  memory: z.object(measurements('rssMB')).nullish(),
  chunks: z
    .object(
      measurements(
        'live',
        'dirty',
        'modifiedInMemory',
        'generatedTotal',
        'generatedPerS',
        'genMeanMs',
        'genBacklog',
        'memHits',
        'diskHits',
        'mapColumns',
        'servedTotal',
        'servedPerS',
        'displayed',
        'savedColumns',
        'storageBytes',
      ),
    )
    .nullish(),
  sim: z.object(measurements('pending', 'falling', 'updatesPerS')).nullish(),
  clients: z.object(measurements('fpsMean', 'displayedColumns')).nullish(),
  entities: z.object(measurements('creatures', 'items', 'projectiles')).nullish(),
  worldTime: z.object(measurements('dayLengthS', 'dayFraction')).nullish(),
});

const seriesKeys = [
  'tps',
  'tickMean',
  'tickP99',
  'players',
  'pingMean',
  'sentKbps',
  'recvKbps',
  'creatures',
  'liveChunks',
  'genPerS',
  'simPerS',
] as const;
const series = z.array(z.number().nullable()).max(600).optional();
const history = z
  .object({
    t: z.array(epochMilliseconds).max(600),
    ...(Object.fromEntries(seriesKeys.map((name) => [name, series])) as Record<
      (typeof seriesKeys)[number],
      typeof series
    >),
  })
  .refine((data) => seriesKeys.every((name) => !data[name] || data[name].length === data.t.length));

const world = z.object({ key, name: label.nullish() });
const chunks = z.object({
  worlds: z
    .array(
      world.extend(
        measurements(
          'live',
          'dirty',
          'modifiedInMemory',
          'generatedColumns',
          'savedColumns',
          'displayedColumns',
          'simPending',
          'falling',
          'players',
        ),
      ),
    )
    .max(256),
  hot: z
    .array(
      z.object({
        world: key,
        ...measurements(
          'face',
          'i',
          'j',
          'score',
          'simWritesPerS',
          'editsPerS',
          'creatures',
          'players',
        ),
        live: flag,
      }),
    )
    .max(256),
});

const storage = z.object({
  ...measurements('totalBytes', 'totalFiles', 'scannedAtMs', 'scanMs'),
  parts: z
    .array(z.object({ key, label: label.nullish(), ...measurements('bytes', 'files') }))
    .max(256),
  worlds: z
    .array(
      world.extend(
        measurements(
          'generatedColumns',
          'generatedBytes',
          'savedColumns',
          'savedBytes',
          'bytesPerColumn',
          'pendingFlush',
          'dirtyLive',
          'regionFiles',
        ),
      ),
    )
    .max(256),
});

const item = z.object({
  code: z.number().int().min(0).max(0xffffffff).nullish().catch(undefined),
  icon: z
    .string()
    .max(128)
    .regex(/^\/pack\/ow_[a-z0-9_]+\.png$/)
    .nullish()
    .catch(undefined),
  name: label.nullish(),
  kind: label.nullish(),
  ...measurements('count', 'wearPct'),
});
const client = z.object(measurements('fps', 'columnsLoaded', 'columnsPending', 'renderDistance'));
const hash = z.string().regex(/^[0-9a-f]{8}$/i);
const playerIdentity = z.object({
  id: z.number().int().nonnegative().max(0xffffffff),
  name: label,
  state: label.nullish(),
  admitted: flag,
  mode: label.nullish(),
  world: label.nullish(),
  ...measurements('connectedS', 'pingMs'),
  skinHash: hash.optional(),
  skin: z.object({ hash: z.unknown().optional() }).nullish(),
  skinHead: z.unknown().optional(),
  skinBody: z.unknown().optional(),
});

// The native UI embeds URLs. Return only a validated fingerprint; the web client
// can then request the head from NickPanel using its own instance permission.
function projectSkin<T extends z.output<typeof playerIdentity>>(player: T) {
  const { skin, skinHead, skinBody, skinHash, ...rest } = player;
  let fingerprint =
    skinHash ??
    (typeof skin?.hash === 'string' && hash.safeParse(skin.hash).success ? skin.hash : undefined);
  if (!fingerprint) {
    for (const path of [skinHead, skinBody]) {
      if (typeof path !== 'string' || path.length > 120) continue;
      const match =
        /^\/api\/live\/skin\?id=(\d{1,10})&h=([0-9a-f]{8})(?:&view=(?:head|body))?$/i.exec(path);
      if (match && Number(match[1]) === player.id) {
        fingerprint = match[2];
        break;
      }
    }
  }
  return { ...rest, ...(fingerprint ? { skinHash: fingerprint.toLowerCase() } : {}) };
}

const rosterMember = playerIdentity
  .extend({
    account: z.unknown().optional(),
    accountVerified: z.unknown().optional(),
  })
  .transform(({ account, accountVerified, ...member }) => ({
    ...projectSkin(member),
    ...(accountVerified === true &&
    typeof account === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(account)
      ? { account, accountVerified: true as const }
      : {}),
  }));
const players = z.object({ players: z.array(rosterMember).max(1024) });
const player = playerIdentity
  .extend({
    account: label.nullish(),
    accountVerified: flag,
    client: client.nullish(),
    heldItem: item.nullish(),
    inSpace: flag,
    pos: z.object(measurements('face', 'x', 'y', 'z')).nullish(),
    geo: z.object(measurements('lon', 'lat', 'alt')).nullish(),
    ...measurements('speed', 'yaw', 'pitch', 'sentKbps', 'recvKbps', 'lossPct', 'mtu'),
    onGround: flag,
    crouching: flag,
    role: z.object({ name: label.nullish() }).nullish(),
    vitals: z
      .object(
        measurements(
          'health',
          'maxHealth',
          'hunger',
          'maxHunger',
          'saturation',
          'maxSaturation',
          'air',
          'maxAir',
        ),
      )
      .nullish(),
    armor: z
      .array(item.extend({ slot: label.nullish() }).nullable())
      .max(8)
      .nullish(),
    inventoryKnown: flag,
    inventory: z
      .object({
        ...measurements('selected', 'reportedAgoS'),
        hotbar: z.array(item.nullable()).max(12),
        bag: z.array(item.nullable()).max(36),
      })
      .nullish(),
    record: z
      .object(
        measurements(
          'joins',
          'playSeconds',
          'blocksBroken',
          'blocksPlaced',
          'deaths',
          'playerKills',
          'creatureKills',
          'damageDealt',
          'damageTaken',
          'walkedMeters',
          'flownMeters',
          'highestAltitude',
          'chatMessages',
        ),
      )
      .extend({ firstSeenMs: epochMilliseconds.nullish().catch(null) })
      .nullish(),
    stats: z
      .object(
        measurements(
          'inputs',
          'accepted',
          'violationsFast',
          'violationsWall',
          'violationsFly',
          'teleports',
        ),
      )
      .nullish(),
  })
  .transform(projectSkin);

export const openworldTelemetrySchemas = { status, history, chunks, storage, players, player };
export type OpenworldTelemetryResource = keyof typeof openworldTelemetrySchemas;
export type OpenworldTelemetryData = {
  [K in OpenworldTelemetryResource]: z.output<(typeof openworldTelemetrySchemas)[K]>;
};
export type OpenworldObservationReason = 'offline' | 'not_ready' | 'unreachable';
export type OpenworldObservation<K extends OpenworldTelemetryResource> = {
  gameVersion?: string;
} & (
  | {
      source: 'live';
      observedAt: string;
      processRef?: string;
      reason: null;
      data: OpenworldTelemetryData[K];
    }
  | {
      source: 'snapshot';
      observedAt: string;
      reason: OpenworldObservationReason;
      data: OpenworldTelemetryData[K];
    }
  | { source: 'unavailable'; observedAt: null; reason: OpenworldObservationReason; data: null }
);
