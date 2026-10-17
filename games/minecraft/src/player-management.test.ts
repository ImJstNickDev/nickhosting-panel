import { describe, expect, it } from 'vitest';
import {
  minecraftPlayerActionSchema,
  minecraftPlayerCommand,
  parseMinecraftOnlinePlayers,
  parseMinecraftPlayerFiles,
} from './player-management.js';

const player = { name: 'PlayerOne', uuid: '11111111-1111-1111-1111-111111111111' };
const files = {
  operators: JSON.stringify([{ ...player, level: 1, bypassesPlayerLimit: false }]),
  whitelist: JSON.stringify([player]),
  banned: '[]',
  properties: 'white-list=true\nenforce-whitelist=false\nrcon.password=secret\n',
};
describe('Minecraft player boundaries', () => {
  it('returns only bounded player fields and whitelist properties', () => {
    const snapshot = parseMinecraftPlayerFiles({
      ...files,
      banned: JSON.stringify([
        {
          ...player,
          reason: 'Reason',
          expires: 'forever',
          source: 'private-admin',
          created: 'private-date',
        },
      ]),
    });
    expect(snapshot).toEqual({
      operators: [{ ...player, level: 1, bypassesPlayerLimit: false }],
      whitelist: [player],
      banned: [{ ...player, reason: 'Reason', expires: 'forever' }],
      whitelistEnabled: true,
      enforceWhitelist: false,
    });
  });
  it.each(['invalid', '{}', '[{}]', JSON.stringify([player, player]), ' '.repeat(1048577)])(
    'fails closed on malformed or oversized lists',
    (whitelist) => {
      expect(() => parseMinecraftPlayerFiles({ ...files, whitelist })).toThrow(
        'integration_unavailable',
      );
    },
  );
  it('defaults the absent historical bypass flag to false without inventing operator levels', () => {
    expect(
      parseMinecraftPlayerFiles({ ...files, operators: JSON.stringify([{ ...player, level: 4 }]) })
        .operators[0]?.bypassesPlayerLimit,
    ).toBe(false);
    expect(() =>
      parseMinecraftPlayerFiles({ ...files, operators: JSON.stringify([player]) }),
    ).toThrow('integration_unavailable');
  });
  it('does not fabricate an empty disabled whitelist when properties are missing', () => {
    expect(() => parseMinecraftPlayerFiles({ ...files, properties: '' })).toThrow(
      'integration_unavailable',
    );
    expect(
      parseMinecraftPlayerFiles({ ...files, properties: 'white-list=false' }).enforceWhitelist,
    ).toBe(false);
  });
  it('builds bounded single-line command actions', () => {
    expect(minecraftPlayerCommand({ action: 'whitelist-add', name: 'PlayerOne' })).toBe(
      'whitelist add PlayerOne',
    );
    expect(
      minecraftPlayerCommand({ action: 'ban', name: 'PlayerOne', reason: 'Repeated griefing' }),
    ).toBe('ban PlayerOne Repeated griefing');
    expect(minecraftPlayerCommand({ action: 'whitelist-off' })).toBe('whitelist off');
  });
  it.each([
    { action: 'op', name: '@a' },
    { action: 'kick', name: 'PlayerOne', reason: ' hello\n' },
    { action: 'kick', name: 'PlayerOne', reason: 'hello\nstop' },
    { action: 'kick', name: 'PlayerOne', reason: 'hello\u2028stop' },
    { action: 'ban', name: 'PlayerOne', reason: 'a'.repeat(257) },
    { action: 'op', name: 'PlayerOne', reason: 'unexpected' },
    { action: 'whitelist-on', name: 'PlayerOne' },
    { action: 'stop' },
  ])('rejects selectors, injection and unsupported fields/actions', (input) =>
    expect(minecraftPlayerActionSchema.safeParse(input).success).toBe(false),
  );
  it('recognizes complete fresh list receipts, including zero players', () => {
    expect(
      parseMinecraftOnlinePlayers(
        '[12:34:56] [Server thread/INFO]: There are 2 of a max of 20 players online: PlayerOne, PlayerTwo',
      ),
    ).toEqual([{ name: 'PlayerOne' }, { name: 'PlayerTwo' }]);
    expect(
      parseMinecraftOnlinePlayers(
        '[12:34:56] [Server thread/INFO]: There are 0 of a max of 20 players online: ',
      ),
    ).toEqual([]);
  });
  it.each([
    '[12:34:56] [Server thread/INFO]: <PlayerOne> There are 1 of a max of 20 players online: PlayerOne',
    '[12:34:56] [Async Chat Thread/INFO]: There are 1 of a max of 20 players online: PlayerOne',
    '[12:34:56] [Server thread/INFO]: [Plugin] There are 1 of a max of 20 players online: PlayerOne',
    '[12:34:56] [Server thread/INFO]: There are 2 of a max of 20 players online: PlayerOne',
    '[12:34:56] [Server thread/INFO]: There are 2 of a max of 20 players online: PlayerOne, PlayerOne',
    '[12:34:56] [Server thread/INFO]: There are 1 of a max of 20 players online: PlayerOne\n',
    'There are 1 of a max of 20 players online: PlayerOne',
  ])('ignores chat, incomplete, duplicate and untrusted receipts', (line) =>
    expect(parseMinecraftOnlinePlayers(line)).toBeUndefined(),
  );
});
