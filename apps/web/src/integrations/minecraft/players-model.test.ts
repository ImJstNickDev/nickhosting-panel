import { describe, expect, it } from 'vitest';
import { mergeMinecraftPlayers } from './players-model.js';

const id = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const snapshot = {
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
});
