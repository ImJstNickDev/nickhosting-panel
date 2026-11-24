import { expect, it, vi } from 'vitest';
import {
  dispatchOpenworldPlayerAction,
  readOpenworldDestinations,
} from './native-player-actions.js';
import { type OpenworldPlayerAction, openworldActionSchema } from './player-actions.js';

const subject = { id: 7, name: 'Ada', joinedAt: 17 };
const base = {
  requestId: '20bf899a-549e-4d25-b59f-4a92b8369c9d',
  processRef: 'd'.repeat(64),
  player: subject,
};
const scope = {
  origin: 'http://fixture.example.test:25000',
  token: 'private-token',
  signal: new AbortController().signal,
};

it('sends one typed JSON POST using only the native action and its parameters', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
  const cases: [OpenworldPlayerAction, object][] = [
    [{ kind: 'message', text: 'Hello' }, { text: 'Hello' }],
    [{ kind: 'kick' }, { reason: '' }],
    [{ kind: 'gamemode', mode: 'spectator' }, { mode: 'spectator' }],
    [{ kind: 'kill' }, {}],
    [{ kind: 'respawn' }, {}],
    [{ kind: 'screenshot' }, {}],
    [
      { kind: 'teleport', destination: { type: 'coordinates', lon: 17, lat: 58, world: 'earth' } },
      { world: 'earth', lon: 17, lat: 58, alt: null },
    ],
    [{ kind: 'teleport', destination: { type: 'checkpoint', id: 10 } }, { toCheckpoint: 10 }],
    [
      {
        kind: 'teleport',
        destination: { type: 'player', player: { ...subject, id: 11, name: 'Grace' } },
      },
      { toPlayer: 11 },
    ],
  ];
  for (const [action, fields] of cases) {
    const input = openworldActionSchema.parse({ ...base, action });
    await dispatchOpenworldPlayerAction({ ...scope, fetcher }, 7, input.action);
    const call = fetcher.mock.calls.at(-1);
    expect(call?.[0]?.toString()).toBe(`${scope.origin}/api/live/player/${action.kind}`);
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'X-OW-Token': scope.token },
    });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ id: 7, ...fields });
  }
  expect(fetcher).toHaveBeenCalledTimes(cases.length);
  for (const action of [
    { kind: 'console' },
    { kind: 'message', text: ' ' },
    { kind: 'kick', reason: 'x'.repeat(121) },
    { kind: 'teleport', destination: { type: 'coordinates', world: 'earth', lon: 0, lat: 91 } },
  ])
    expect(openworldActionSchema.safeParse({ ...base, action }).success).toBe(false);
});
it('distinguishes an explicit refusal from an uncertain response and never replays a command', async () => {
  for (const [response, code] of [
    [Response.json({ ok: false }), 'game_request_rejected'],
    [Response.json({ ok: false }, { status: 409 }), 'game_request_rejected'],
    [Response.json({ ok: true }, { status: 500 }), 'operation_uncertain'],
    [Response.json({}), 'operation_uncertain'],
    [new Response('broken'), 'operation_uncertain'],
  ] as const) {
    const fetcher = vi.fn<typeof fetch>(async () => response);
    await expect(
      dispatchOpenworldPlayerAction({ ...scope, fetcher }, 7, { kind: 'kick' }),
    ).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it('projects only selectable worlds and checkpoints', async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith('/chunks')
      ? Response.json({ worlds: [{ key: 'earth' }, { key: 'moon', name: 'Luna' }], hot: [] })
      : Response.json({
          checkpoints: [{ id: 5, name: 'Camp', world: 'moon', note: 'private', pos: { x: 3 } }],
        }),
  );
  expect(await readOpenworldDestinations({ ...scope, fetcher })).toEqual({
    worlds: [
      { key: 'earth', name: 'earth' },
      { key: 'moon', name: 'Luna' },
    ],
    checkpoints: [{ id: 5, name: 'Camp', world: 'moon' }],
  });
});
