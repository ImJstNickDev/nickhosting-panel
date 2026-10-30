import { describe, expect, it } from 'vitest';
import { mergeMinecraftPlayers } from './players-model.js';

const id = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const snapshot = {
  knownPlayers: [],
  knownPlayersState: 'available' as const,
  supported: true,
  installed: true,
  operators: [{ uuid: id, name: 'OldName', level: 4, bypassesPlayerLimit: false }],
  whitelist: [{ uuid: id, name: 'NewName' }],
  banned: [],
  whitelistEnabled: false,
  enforceWhitelist: false,
};
describe('Minecraft Players row identity', () => {
  it('merges matching UUIDs while preserving list names and using the observed live name', () => {
    const rows = mergeMinecraftPlayers(snapshot, [{ name: 'NewName' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uuid: id,
      name: 'NewName',
      online: true,
      operator: { name: 'OldName' },
      whitelistEntry: { name: 'NewName' },
      whitelisted: true,
    });
  });
  it('does not merge different UUIDs sharing a historical name or grant their roles to a name-only live row', () => {
    const rows = mergeMinecraftPlayers(
      {
        ...snapshot,
        whitelist: [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'OldName' }],
      },
      [{ name: 'OldName' }],
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.online)).toMatchObject({ name: 'OldName', whitelisted: false });
    expect(rows.find((row) => row.online)?.operator).toBeUndefined();
    expect(rows.find((row) => row.online)?.uuid).toBeUndefined();
  });
  it('includes server-discovered players without inventing a command name for UUID-only data', () => {
    const uuid = '22222222-2222-4222-8222-222222222222';
    const rows = mergeMinecraftPlayers(
      { ...snapshot, knownPlayers: [{ uuid, name: null, sources: ['playerdata'] }] },
      [],
    );
    expect(rows.find((row) => row.uuid === uuid)).toMatchObject({
      name: uuid,
      nameKnown: false,
      online: false,
      whitelisted: false,
    });
    const named = mergeMinecraftPlayers(
      {
        ...snapshot,
        knownPlayers: [{ uuid, name: 'SavedPlayer', sources: ['usercache', 'playerdata'] }],
      },
      [{ name: 'SavedPlayer' }],
    );
    expect(named.find((row) => row.uuid === uuid)).toMatchObject({
      name: 'SavedPlayer',
      nameKnown: true,
      online: true,
    });
  });
});
