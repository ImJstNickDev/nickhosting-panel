import { describe, expect, it } from 'vitest';
import {
  actionAvailability,
  createTrustedGameUiRegistry,
  defineTrustedGameUiModule,
  gameUiDescriptorSchema,
  type TrustedGameUiModule,
  uiFieldSchema,
  validateUiValues,
  visibleFields,
} from './ui.js';

function fixture() {
  return gameUiDescriptorSchema.parse({
    gameId: 'fixture-arena',
    schemaVersion: 1,
    nameKey: 'games.fixture-arena.name',
    creation: {
      choicesHandler: 'choices',
      createHandler: 'create',
      fields: [
        {
          id: 'mode',
          labelKey: 'games.fixture-arena.mode',
          type: 'choice',
          required: true,
          options: [
            { value: 'duel', labelKey: 'games.fixture-arena.duel' },
            { value: 'team', labelKey: 'games.fixture-arena.team' },
          ],
        },
        {
          id: 'slots',
          labelKey: 'games.fixture-arena.slots',
          type: 'number',
          min: 2,
          max: 16,
          required: true,
          when: [{ field: 'mode', operator: 'equals', values: ['team'] }],
        },
        {
          id: 'map',
          labelKey: 'games.fixture-arena.map',
          type: 'choice',
          required: true,
          source: { handler: 'maps', dependsOn: ['mode'] },
        },
      ],
    },
    sections: [
      {
        id: 'arena',
        titleKey: 'games.fixture-arena.arena',
        loader: 'load-arena',
        requiredPermissions: ['server:read'],
        requiredCapabilities: ['arena'],
        forms: [
          {
            id: 'arena-settings',
            titleKey: 'games.fixture-arena.arena',
            fields: [],
            action: {
              id: 'save',
              handler: 'save',
              labelKey: 'games.fixture-arena.save',
              requiredPermissions: ['server:manage'],
              requiredCapabilities: ['arena'],
              requiresStopped: true,
            },
          },
        ],
      },
    ],
    ports: [
      {
        role: 'game',
        labelKey: 'games.fixture-arena.game',
        transports: ['tcp', 'udp'],
        required: true,
      },
      {
        role: 'query',
        labelKey: 'games.fixture-arena.query',
        transports: ['udp'],
        required: false,
      },
    ],
    connectionModes: [
      { mode: 'static-host-port', showPort: true },
      { mode: 'custom-subdomain', srv: { service: '_fixture', transport: 'udp' } },
    ],
  });
}
function moduleFixture(): TrustedGameUiModule {
  const names = ['name', 'mode', 'duel', 'team', 'slots', 'map', 'arena', 'save', 'game', 'query'];
  const catalog = Object.fromEntries(names.map((name) => [`games.fixture-arena.${name}`, name]));
  return {
    descriptor: fixture(),
    catalogs: { en: catalog, it: catalog },
    handlers: Object.fromEntries(
      ['choices', 'create', 'maps', 'load-arena', 'save'].map((handler) => [
        handler,
        async () => [],
      ]),
    ),
  };
}
describe('browser game UI descriptors', () => {
  it('round-trips bounded serializable descriptors with alternate transport and connection modes', () => {
    const descriptor = fixture();
    expect(gameUiDescriptorSchema.parse(JSON.parse(JSON.stringify(descriptor)))).toEqual(
      descriptor,
    );
    expect(descriptor.ports[0]?.transports).toEqual(['tcp', 'udp']);
    expect(descriptor.connectionModes.map((m) => m.mode)).toEqual([
      'static-host-port',
      'custom-subdomain',
    ]);
  });
  it('rejects executable URLs, undeclared fields, duplicate ports and oversized lists', () => {
    const descriptor = fixture();
    expect(
      gameUiDescriptorSchema.safeParse({
        ...descriptor,
        moduleUrl: 'https://example.invalid/plugin.js',
      }).success,
    ).toBe(false);
    expect(
      gameUiDescriptorSchema.safeParse({
        ...descriptor,
        ports: [...descriptor.ports, descriptor.ports[0]],
      }).success,
    ).toBe(false);
    expect(
      gameUiDescriptorSchema.safeParse({
        ...descriptor,
        sections: Array(33).fill(descriptor.sections[0]),
      }).success,
    ).toBe(false);
    const bad = structuredClone(descriptor);
    if (bad.creation.fields[2]?.type === 'choice' && bad.creation.fields[2].source)
      bad.creation.fields[2].source.dependsOn = ['undeclared'];
    expect(gameUiDescriptorSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects cross-game translation namespaces, invalid bounds and ambiguous conditions', () => {
    expect(
      gameUiDescriptorSchema.safeParse({ ...fixture(), nameKey: 'games.other.name' }).success,
    ).toBe(false);
    const descriptor = fixture();
    const field = descriptor.creation.fields[1];
    if (field?.type === 'number') field.min = 50;
    expect(gameUiDescriptorSchema.safeParse(descriptor).success).toBe(false);
    expect(
      uiFieldSchema.safeParse({
        id: 'ok',
        labelKey: 'games.fixture-arena.ok',
        type: 'boolean',
        when: [{ field: 'mode', operator: 'equals', values: [] }],
      }).success,
    ).toBe(false);
  });
  it('handles conditional fields, async evidence-filtered options and unknown/disabled selections', () => {
    const fields = fixture().creation.fields;
    expect(visibleFields(fields, { mode: 'duel' }).map((f) => f.id)).toEqual(['mode', 'map']);
    expect(
      validateUiValues(
        fields,
        { mode: 'duel', slots: 999, map: 'arena-1' },
        { map: [{ value: 'arena-1', label: 'Arena 1', disabled: false }] },
      ),
    ).toEqual([]);
    expect(
      validateUiValues(fields, { mode: 'team', slots: 1, map: 'unknown' }, { map: [] }),
    ).toEqual([
      { field: 'slots', code: 'invalid' },
      { field: 'map', code: 'unavailable' },
    ]);
    expect(
      validateUiValues(
        fields,
        { mode: 'duel', map: 'arena-1' },
        { map: [{ value: 'arena-1', label: 'Arena 1', disabled: true }] },
      ),
    ).toEqual([{ field: 'map', code: 'unavailable' }]);
  });
  it('validates booleans, player inputs, integer limits and does not accept inherited values', () => {
    const fields = [
      uiFieldSchema.parse({
        id: 'consent',
        labelKey: 'games.fixture-arena.consent',
        type: 'boolean',
        mustBeTrue: true,
        required: true,
      }),
      uiFieldSchema.parse({
        id: 'players',
        labelKey: 'games.fixture-arena.players',
        type: 'multi-text',
        format: 'player-name',
        maxItems: 2,
        maxLength: 16,
      }),
    ];
    expect(validateUiValues(fields, { consent: false, players: ['bad name'] })).toEqual([
      { field: 'consent', code: 'invalid' },
      { field: 'players', code: 'invalid' },
    ]);
    expect(validateUiValues(fields, Object.create({ consent: true }))).toEqual([
      { field: 'consent', code: 'required' },
    ]);
  });
  it('never treats capabilities as permissions, rollout, verified runtime or provider readiness', () => {
    const action = fixture().sections[0]?.forms[0]?.action;
    if (!action) throw new Error('missing fixture');
    const context = {
      permissions: ['server:manage'],
      capabilities: ['arena'],
      rolloutAllowed: true,
      runtimeVerified: true,
      providerConfigured: true,
      state: 'offline',
    };
    expect(actionAvailability(action, context)).toEqual({ enabled: true });
    expect(actionAvailability(action, { ...context, permissions: [] })).toEqual({
      enabled: false,
      reason: 'forbidden',
    });
    expect(actionAvailability(action, { ...context, capabilities: [] })).toEqual({
      enabled: false,
      reason: 'unsupported',
    });
    for (const flag of ['rolloutAllowed', 'runtimeVerified', 'providerConfigured'])
      expect(actionAvailability(action, { ...context, [flag]: false })).toEqual({
        enabled: false,
        reason: 'unavailable',
      });
    expect(actionAvailability(action, { ...context, state: 'running' })).toEqual({
      enabled: false,
      reason: 'requires-stopped',
    });
  });
  it('registers only supplied static modules and validates both locales and every handler', () => {
    const module = moduleFixture();
    const registry = createTrustedGameUiRegistry([module]);
    expect(registry.get('fixture-arena')?.descriptor.gameId).toBe('fixture-arena');
    expect(registry.get('untrusted-api-game')).toBeUndefined();
    expect(Object.isFrozen(registry.get('fixture-arena')?.descriptor.creation.fields)).toBe(true);
    expect(() => createTrustedGameUiRegistry([module, module])).toThrow('duplicate');
    expect(() => defineTrustedGameUiModule({ ...module, handlers: {} })).toThrow('handler_missing');
    expect(() =>
      defineTrustedGameUiModule({ ...module, catalogs: { en: module.catalogs.en, it: {} } }),
    ).toThrow('translation_missing');
  });
});

it('accepts only registered artwork identifiers and fails safely without artwork', () => {
  const descriptor = fixture();
  expect(
    gameUiDescriptorSchema.safeParse({
      ...descriptor,
      artwork: { assetId: 'https://untrusted.invalid/art.svg' },
    }).success,
  ).toBe(false);
  expect(
    gameUiDescriptorSchema.safeParse({
      ...descriptor,
      artwork: { assetId: 'landscape', url: 'https://untrusted.invalid/art.svg' },
    }).success,
  ).toBe(false);
  const module = moduleFixture();
  expect(() =>
    defineTrustedGameUiModule({
      ...module,
      descriptor: { ...descriptor, artwork: { assetId: 'landscape' } },
    }),
  ).toThrow('asset_missing');
  expect(
    createTrustedGameUiRegistry([module]).get('fixture-arena')?.descriptor.artwork,
  ).toBeUndefined();
});

describe('installer page contracts', () => {
  it('requires existing correctly typed fields and unique resource presets', () => {
    const descriptor = fixture();
    expect(
      gameUiDescriptorSchema.safeParse({
        ...descriptor,
        creation: {
          ...descriptor.creation,
          pages: [
            {
              id: 'version',
              titleKey: 'games.fixture-arena.name',
              field: 'missing',
              kind: 'version-list',
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      gameUiDescriptorSchema.safeParse({
        ...descriptor,
        creation: {
          ...descriptor.creation,
          pages: [
            {
              id: 'players',
              titleKey: 'games.fixture-arena.name',
              field: 'mode',
              kind: 'players',
              lookupHandler: 'lookup',
            },
          ],
        },
      }).success,
    ).toBe(false);
    const preset = {
      id: 'small',
      labelKey: 'games.fixture-arena.name',
      memoryMiB: 2048,
      cpuPercent: 100,
    };
    expect(
      gameUiDescriptorSchema.safeParse({
        ...descriptor,
        creation: { ...descriptor.creation, resourcePresets: [preset, preset] },
      }).success,
    ).toBe(false);
  });
});
