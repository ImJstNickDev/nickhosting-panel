import { expect, it, vi } from 'vitest';
import { OpenworldTokenExpired } from './dashboard-api.js';
import {
  dispatchOpenworldCheckpoint,
  readOpenworldCheckpoints,
  readOpenworldMapWorlds,
} from './native-checkpoints.js';
import { type OpenworldCheckpointAction, openworldCheckpointActionSchema } from './world-map.js';

const connection = {
  origin: 'http://fixture.test:24711',
  token: 'fixture-only',
  signal: new AbortController().signal,
};
const fields = {
  name: 'Ridge',
  note: 'Meeting place',
  color: '#3E8EFF',
  icon: 'flag',
  visibility: 'admins',
} as const;
const record = {
  id: 10,
  world: 'earth',
  ...fields,
  createdAtMs: 49123456,
  pos: { face: 3, x: 800, y: 100, z: 400 },
  geo: { lat: 22.1, lon: 4.5, alt: 100 },
};
const position = { type: 'geo', lat: 22.1, lon: 4.5, alt: null } as const;
const revision = 'e'.repeat(64);

it('lists planetary worlds from one live observation, including when geometry is unavailable', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      worlds: [
        { key: 'moon', name: 'Moon', faceEdgeMeters: 394816 },
        { key: 'ships' },
        { key: 'earth' },
      ],
    }),
  );
  expect(await readOpenworldMapWorlds({ ...connection, fetcher })).toEqual([
    { key: 'moon', name: 'Moon', faceEdgeMeters: 394816 },
    { key: 'earth', name: 'earth', faceEdgeMeters: null },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0].toString()).toBe(`${connection.origin}/api/live/chunks`);
});

it('restricts the checkpoint list to the selected world and the public projection', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      checkpoints: [
        { ...record, author: 'private network address', helio: [1, 2, 3] },
        { ...record, world: 'moon' },
      ],
    }),
  );
  expect(await readOpenworldCheckpoints({ ...connection, fetcher }, 'earth')).toEqual([record]);
  const [url, init] = fetcher.mock.calls[0] ?? [];
  expect(url?.toString()).toBe(`${connection.origin}/api/live/checkpoints?world=earth`);
  expect(init).toMatchObject({ redirect: 'error', headers: { 'X-OW-Token': connection.token } });
});

it('applies the native UTF-8 limits to mutable fields and validates both coordinate forms', () => {
  const input = (name: string, note: string) => ({
    kind: 'create',
    fields: { ...fields, name, note },
    position,
  });
  expect(
    openworldCheckpointActionSchema.safeParse(input('é'.repeat(32), '🌄'.repeat(125))).success,
  ).toBe(true);
  expect(openworldCheckpointActionSchema.safeParse(input('é'.repeat(33), '')).success).toBe(false);
  expect(openworldCheckpointActionSchema.safeParse(input('Camp', '🌄'.repeat(126))).success).toBe(
    false,
  );
  for (const invalid of [
    { ...position, lat: 91 },
    { ...position, lon: -181 },
    { type: 'face', face: 6, x: 4, y: null, z: 1 },
    { type: 'face', face: 1, x: -1, y: null, z: 2 },
  ]) {
    expect(
      openworldCheckpointActionSchema.safeParse({ kind: 'create', fields, position: invalid })
        .success,
    ).toBe(false);
  }
});

it('projects geographic, face-relative, metadata-only and delete requests onto their native endpoints', async () => {
  const cases: [OpenworldCheckpointAction, string, object][] = [
    [
      { kind: 'create', fields, position },
      'checkpoints',
      { ...fields, world: 'earth', lat: 22.1, lon: 4.5, alt: null },
    ],
    [
      {
        kind: 'update',
        id: 10,
        revision,
        fields,
        position: { type: 'face', face: 3, x: 800, y: null, z: 400 },
      },
      'checkpoints/update',
      { id: 10, ...fields, world: 'earth', face: 3, x: 800, y: null, z: 400 },
    ],
    [{ kind: 'update', id: 10, revision, fields }, 'checkpoints/update', { id: 10, ...fields }],
    [{ kind: 'delete', id: 10, revision }, 'checkpoints/delete', { id: 10 }],
  ];
  for (const [action, path, body] of cases) {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(action.kind === 'delete' ? { ok: true } : record),
    );
    await dispatchOpenworldCheckpoint({ ...connection, fetcher }, 'earth', action);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url?.toString()).toBe(`${connection.origin}/api/live/${path}`);
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'X-OW-Token': connection.token },
    });
  }
});

it('distinguishes expired login, game refusal, and an ambiguous write with no replay', async () => {
  const action = { kind: 'update', id: 10, revision, fields } as const;
  for (const [reply, code] of [
    [Response.json(null, { status: 404 }), 'not_found'],
    [Response.json(null, { status: 400 }), 'game_request_rejected'],
    [Response.json(null, { status: 503 }), 'operation_uncertain'],
    [Response.json({ ok: true }), 'operation_uncertain'],
    [Response.json({ ...record, id: 99 }), 'operation_uncertain'],
    [Response.json({ ...record, world: 'moon' }), 'operation_uncertain'],
    [new Response('too big', { headers: { 'content-length': '65536' } }), 'operation_uncertain'],
  ] as const) {
    const fetcher = vi.fn<typeof fetch>(async () => reply);
    await expect(
      dispatchOpenworldCheckpoint({ ...connection, fetcher }, 'earth', action),
    ).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(null, { status: 401 }));
  await expect(
    dispatchOpenworldCheckpoint({ ...connection, fetcher }, 'earth', action),
  ).rejects.toBeInstanceOf(OpenworldTokenExpired);
  await expect(
    readOpenworldCheckpoints({ ...connection, fetcher }, 'earth'),
  ).rejects.toBeInstanceOf(OpenworldTokenExpired);
});

it('bounds game responses and refuses invalid checkpoint records', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response('[]', { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    )
    .mockResolvedValueOnce(Response.json({ checkpoints: [{ ...record, color: 'url(example)' }] }));
  for (let i = 0; i < 2; i++)
    await expect(
      readOpenworldCheckpoints({ ...connection, fetcher }, 'earth'),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
});
