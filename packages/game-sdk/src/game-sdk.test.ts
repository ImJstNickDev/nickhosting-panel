import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertGameAccess,
  defineGameIntegration,
  evaluateGameAccess,
  type GameIntegration,
  type GameManifest,
  type GameRollout,
  gameManifestSchema,
  gameRolloutStates,
} from './index.js';

describe('game rollout contracts', () => {
  const user = { userId: 'user', role: 'user' as const };
  const owner = { userId: 'owner', role: 'owner' as const };
  const policy = (state: GameRollout['state'], allowedUserIds: string[] = []): GameRollout => ({
    gameId: 'fixture-game',
    state,
    allowedUserIds,
  });
  it('uses exactly the documented persisted state enum', () => {
    expect(gameRolloutStates).toEqual([
      'development',
      'private-testing',
      'public',
      'disabled-for-new-servers',
    ]);
  });
  it('hides development and private games from unlisted users', () => {
    for (const state of ['development', 'private-testing'] as const)
      expect(evaluateGameAccess(policy(state), user)).toEqual({
        visible: false,
        canCreate: false,
        canManageExisting: false,
      });
    expect(evaluateGameAccess(policy('private-testing', [user.userId]), user).canCreate).toBe(true);
    expect(evaluateGameAccess(policy('development', [user.userId]), user).canCreate).toBe(false);
    expect(evaluateGameAccess(policy('public'), user)).toEqual({
      visible: true,
      canCreate: true,
      canManageExisting: false,
    });
  });
  it('preserves Owner access, but disables creation for everyone in disabled state', () => {
    for (const state of gameRolloutStates) {
      expect(evaluateGameAccess(policy(state), owner)).toEqual({
        visible: true,
        canCreate: state !== 'disabled-for-new-servers',
        canManageExisting: true,
      });
    }
    expect(evaluateGameAccess(policy('disabled-for-new-servers', [user.userId]), user)).toEqual({
      visible: false,
      canCreate: false,
      canManageExisting: false,
    });
  });
  it('preserves authorized existing-server management after rollout changes without granting creation', () => {
    for (const state of gameRolloutStates) {
      const access = evaluateGameAccess(policy(state), user, { hasExistingServerAccess: true });
      expect(access.visible).toBe(true);
      expect(access.canManageExisting).toBe(true);
      expect(access.canCreate).toBe(state === 'public');
    }
    expect(() =>
      assertGameAccess(evaluateGameAccess(policy('private-testing'), user), 'canCreate'),
    ).toThrow('forbidden');
  });
  it('rejects invalid rollout input rather than accidentally publishing a game', () => {
    expect(() =>
      evaluateGameAccess({ ...policy('public'), state: 'publik' } as unknown as GameRollout, user),
    ).toThrow('validation_failed');
  });
});

describe('game integration manifest', () => {
  const manifest: GameManifest = {
    id: 'fixture-game',
    version: '0.1.0',
    nameKey: 'games.fixture-game.name',
    capabilities: {
      console: true,
      files: true,
      backups: false,
      players: false,
      mods: false,
      worlds: false,
      idleDetection: false,
      gracefulStop: false,
      readiness: false,
      wake: 'unsupported',
    },
    connection: {
      mode: 'static-host-port',
      hostnameSettingKey: 'games.fixture.hostname',
      showPort: true,
    },
    ports: [{ role: 'game', transport: 'both', required: true }],
    runtimes: [
      {
        id: 'default',
        nameKey: 'games.fixture-game.runtime.default',
        supportedGameVersions: ['1'],
        supports: {},
      },
    ],
    wizard: {
      steps: [{ id: 'configure', titleKey: 'games.fixture-game.configure', fields: ['name'] }],
    },
    management: [
      { id: 'console', titleKey: 'games.fixture-game.console', requiredCapability: 'console' },
    ],
    contentProviders: [],
    localizations: { namespace: 'games.fixture-game', locales: ['en', 'it'] },
  };
  const integration: GameIntegration = {
    manifest,
    runtimes: [
      {
        id: 'default',
        configurationSchema: z.record(z.string(), z.unknown()),
        async buildPlan(configuration, gameVersion) {
          return {
            gameId: manifest.id,
            runtimeId: 'default',
            gameVersion,
            configuration,
            ports: manifest.ports,
          };
        },
      },
    ],
  };
  it('validates a minimal first-party integration without infrastructure credentials', async () => {
    const result = defineGameIntegration(integration);
    const plan = await result.runtimes[0]?.buildPlan({ name: 'Fixture' }, '1');
    expect(plan).toMatchObject({ gameId: 'fixture-game', runtimeId: 'default', gameVersion: '1' });
    expect(JSON.stringify(plan)).not.toMatch(/eggId|nestId|apiKey/);
  });
  it('rejects mismatched runtime implementations and unsupported capability declarations', () => {
    expect(() => defineGameIntegration({ ...integration, runtimes: [] })).toThrow(
      'configuration_invalid',
    );
    expect(() =>
      defineGameIntegration({
        ...integration,
        manifest: {
          ...manifest,
          capabilities: { ...manifest.capabilities, wake: 'verified-protocol' },
        },
      }),
    ).toThrow('configuration_invalid');
    expect(() =>
      defineGameIntegration({
        ...integration,
        manifest: { ...manifest, capabilities: { ...manifest.capabilities, readiness: true } },
      }),
    ).toThrow('configuration_invalid');
  });
  it('rejects duplicate ports, cross-game translations and missing shipped locale', () => {
    expect(
      gameManifestSchema.safeParse({ ...manifest, ports: [...manifest.ports, ...manifest.ports] })
        .success,
    ).toBe(false);
    expect(gameManifestSchema.safeParse({ ...manifest, nameKey: 'games.other.name' }).success).toBe(
      false,
    );
    expect(
      gameManifestSchema.safeParse({
        ...manifest,
        localizations: { namespace: 'games.fixture-game', locales: ['en', 'en'] },
      }).success,
    ).toBe(false);
    expect(
      gameManifestSchema.safeParse({ ...manifest, eggId: 'injected-hardcoded-egg' }).success,
    ).toBe(false);
  });
});
