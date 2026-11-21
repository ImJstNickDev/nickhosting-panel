import { expect, it, vi } from 'vitest';
import type { OpenworldNativeConnection } from './native-diagnostics.js';
import { canUnbanOpenworldAccount, openworldRuleActionSchema } from './rules.js';
import { performOpenworldRule, readOpenworldRules } from './rules-native.js';

const account = 'c7608bae-65b7-413e-a7eb-cb43ccd12c8b';
const other = 'd31de5f5-1f3a-49d7-a591-1445de348ffd';
const bytes = (object: unknown) => new TextEncoder().encode(JSON.stringify(object));

function fixture() {
  const records: { seq: number; text: string }[] = [];
  const sent: string[] = [];
  const state = {
    level: 'Normal',
    banned: [account, other],
    reject: false,
    unconfirmed: false,
    gap: false,
  };
  const append = (component: string, text: string) =>
    records.push({
      seq: records.length + 1,
      text: `2026-11-21 01:02:03.123 [INFO ] [${component}] [t0] ${text}`,
    });
  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    expect(u.origin + u.pathname).toBe('http://fixture/api/live/console');
    expect(new Headers(init?.headers).get('X-OW-Token')).toBe('fixture');
    expect(init?.redirect).toBe('error');
    if (init?.method !== 'POST') {
      const after = u.searchParams.get('after');
      return Response.json({
        last: records.length,
        lines:
          after === null
            ? records.slice(-1)
            : records.filter((row) => row.seq > Number(after)).slice(0, 500),
      });
    }
    const cmd = JSON.parse(String(init.body)).command;
    sent.push(cmd);
    const lists: Record<string, string[]> = {
      difficulty: [`Difficulty: ${state.level}. Test settings.`],
      'role list': [
        'Roles (the default one: player):',
        '  • player “Player” — priority 0, parent -, homes 3, 0 player(s)',
      ],
      'zone list': [
        '1 zone(s). Server rules: -',
        '  • Harbor — Earth, \u001ecircle of {0}, priority 80 m: 3',
      ],
      'border info': [
        'Travel rules: space is closed.',
        '  • Earth: open, no border',
        '  • Moon: closed',
        '  • Mars: a border of 2.5 km around lon -1.23456, lat 2.34567',
      ],
      banlist: state.banned.length
        ? [
            `${state.banned.length} banned player(s):`,
            ...state.banned.map((id) => `  Ada (${id}), banned by internal-admin: Example reason`),
          ]
        : ['Nobody is banned.'],
    };
    append('web', `web console (192.0.2.2) > ${cmd}  (WebActions.cpp:77)`);
    append('chat', 'console:   • Hidden — confidential  (ConsoleVerbs.cpp:620)');
    const mutating = cmd.startsWith('difficulty ') || cmd.startsWith('unban ');
    if (mutating && !state.reject && !state.unconfirmed) {
      if (cmd.startsWith('difficulty ')) state.level = 'Hard';
      else state.banned = state.banned.filter((id) => id !== cmd.slice(6));
    }
    for (const l of lists[cmd] ?? ['Done.'])
      append('server-console', `console: ${l}  (ConsoleVerbs.cpp:618)`);
    if (state.gap && cmd === 'role list')
      append('web', 'web console (192.0.2.3) > status  (WebActions.cpp:77)');
    append(
      'server-console',
      `EVT event=console.${mutating && state.reject ? 'reject' : 'exec'} req=RULES verb=${cmd.split(' ')[0]}  (ConsoleVerbs.cpp:621)`,
    );
    return Response.json({ ok: true });
  };
  const native: OpenworldNativeConnection = {
    origin: 'http://fixture',
    fetcher,
    signal: AbortSignal.timeout(8000),
    token: 'fixture',
  };
  return { native, sent, state };
}
it('projects rule groups, strips unrelated console and ban issuer, tolerates an unrecognized group', async () => {
  const { native, state } = fixture();
  const data = await readOpenworldRules(native, 'a1.2.9');
  expect(data.difficulty).toBe('normal');
  expect(data.roles?.entries[0]).toMatchObject({ key: 'player', permissions: null });
  expect(data.zones).toEqual([{ name: 'Harbor', world: 'Earth', description: '80 m' }]);
  expect(data.borders).toEqual({
    spaceOpen: false,
    worlds: [
      { world: 'Earth', description: 'open' },
      { world: 'Moon', description: 'closed' },
      {
        world: 'Mars',
        description: 'bounded',
        border: { radiusMeters: 2500, longitude: -1.23456, latitude: 2.34567 },
      },
    ],
  });
  expect(data.bans).toEqual(
    [account, other].map((uuid) => ({ uuid, name: 'Ada', reason: 'Example reason' })),
  );
  expect(JSON.stringify(data)).not.toMatch(/confidential|internal-admin|fixture|ConsoleVerbs/);
  state.gap = true;
  const partial = await readOpenworldRules(native, 'unverified');
  expect(partial.roles).toBeNull();
  expect(partial.bans).toHaveLength(2);
  expect(partial.capabilities).toEqual({ difficulty: false, unban: false });
});
it('reads configured permissions and flags without projecting player assignments', async () => {
  const { native, sent } = fixture();
  const data = await readOpenworldRules(
    native,
    'a1.2.9',
    async () =>
      bytes({
        format: 2,
        defaultRole: 'player',
        roles: { player: { name: 'Player', priority: 0, permissions: ['chat'] } },
        players: { 'private-player': 'superadmin' },
      }),
    async () =>
      bytes({
        format: 1,
        zones: [
          {
            name: 'Harbor',
            world: 'earth',
            shape: 'circle',
            radius: 80,
            flags: { pvp: 'deny' },
            members: ['private-player'],
          },
        ],
      }),
  );
  expect(data.roles?.entries[0]?.permissions).toEqual(['chat']);
  expect(data.zones?.[0]?.flags).toEqual([{ key: 'pvp', value: 'deny' }]);
  expect(JSON.stringify(data)).not.toContain('private-player');
  expect(sent).not.toContain('role list');
});
it('checks a fresh postcondition and removes only the selected account when names match', async () => {
  const f = fixture();
  const before = vi.fn(async () => {});
  await performOpenworldRule(f.native, 'a1.2.9', { kind: 'unban', uuid: account }, before);
  expect(f.sent).toEqual(['banlist', `unban ${account}`, 'banlist']);
  expect(f.state.banned).toEqual([other]);
  expect(before).toHaveBeenCalledOnce();
  await performOpenworldRule(f.native, 'a1.2.9', { kind: 'difficulty', value: 'hard' }, before);
  expect(f.state.level).toBe('Hard');
  await expect(
    performOpenworldRule(f.native, 'a1.2.9', { kind: 'unban', uuid: account }, before),
  ).rejects.toMatchObject({ code: 'not_found' });
});
it('distinguishes native rejection from accepted HTTP with an unchanged postcondition', async () => {
  const f = fixture();
  const before = async () => {};
  f.state.reject = true;
  await expect(
    performOpenworldRule(f.native, 'a1.2.9', { kind: 'unban', uuid: account }, before),
  ).rejects.toMatchObject({ code: 'game_request_rejected' });
  f.state.reject = false;
  f.state.unconfirmed = true;
  await expect(
    performOpenworldRule(f.native, 'a1.2.9', { kind: 'unban', uuid: account }, before),
  ).rejects.toMatchObject({ code: 'operation_uncertain' });
});
it('requires a verified release, UUID and allowed action before dispatch', async () => {
  const f = fixture();
  const before = vi.fn(async () => {});
  expect(canUnbanOpenworldAccount('guest:Ada')).toBe(false);
  expect(openworldRuleActionSchema.safeParse({ kind: 'ban', uuid: account }).success).toBe(false);
  expect(openworldRuleActionSchema.safeParse({ kind: 'unban', uuid: 'Ada\nstop' }).success).toBe(
    false,
  );
  await expect(
    performOpenworldRule(f.native, 'next', { kind: 'unban', uuid: account }, before),
  ).rejects.toMatchObject({ code: 'game_request_unsupported' });
  expect(f.sent).toEqual([]);
  expect(before).not.toHaveBeenCalled();
});

it('falls back to native role and zone summaries if the optional file provider cannot read them', async () => {
  const { native, sent } = fixture();
  const failure = async () => {
    throw new Error('unavailable file provider');
  };
  const data = await readOpenworldRules(native, 'a1.2.9', failure, failure);
  expect(data.roles?.entries[0]?.permissions).toBeNull();
  expect(data.zones).toEqual([{ name: 'Harbor', world: 'Earth', description: '80 m' }]);
  expect(sent).toContain('role list');
});
