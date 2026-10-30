import { describe, expect, it } from 'vitest';
import {
  assertServerPermissionKeys,
  legacyServerPermissionKeys,
  serverPermissionDefinitions,
} from './server-permissions.js';

describe('server permission contracts', () => {
  it('requires read for writes and additional actions, rejects unknown and duplicate grants', () => {
    for (const keys of [
      [],
      ['files.write'],
      ['console.power'],
      ['files.read', 'files.read'],
      ['files.read', 'files.unknown'],
      ['unknown.read'],
    ])
      expect(() => assertServerPermissionKeys(keys)).toThrow();
    expect(() =>
      assertServerPermissionKeys(['console.read', 'console.power', 'files.read', 'files.delete']),
    ).not.toThrow();
  });
  it('expands inherited roles without granting new delegation rights', () => {
    const viewer = legacyServerPermissionKeys('viewer');
    expect(viewer).toContain('files.read');
    expect(viewer).not.toContain('files.write');
    const operator = legacyServerPermissionKeys('operator');
    expect(operator).toContain('console.power');
    expect(operator).not.toContain('console.command');
    expect(operator).toContain('backups.create');
    expect(operator).not.toContain('files.write');
    expect(legacyServerPermissionKeys('manager')).toContain('files.write');
    for (const role of ['viewer', 'operator', 'manager'] as const)
      expect(legacyServerPermissionKeys(role).some((key) => key.startsWith('subusers.'))).toBe(
        false,
      );
    expect(legacyServerPermissionKeys('owner')).toHaveLength(serverPermissionDefinitions.length);
  });
  it('accepts only declared integration permissions with their own read dependency', () => {
    const definitions = [
      ...serverPermissionDefinitions,
      {
        key: 'game.fixture.players.read',
        resource: 'game.fixture.players',
        kind: 'read' as const,
        legacy: 'read' as const,
      },
      {
        key: 'game.fixture.players.kick',
        resource: 'game.fixture.players',
        kind: 'additional' as const,
        legacy: 'operate' as const,
      },
    ];
    expect(() => assertServerPermissionKeys(['game.fixture.players.kick'], definitions)).toThrow();
    expect(() =>
      assertServerPermissionKeys(
        ['game.fixture.players.read', 'game.fixture.players.kick'],
        definitions,
      ),
    ).not.toThrow();
  });
});
