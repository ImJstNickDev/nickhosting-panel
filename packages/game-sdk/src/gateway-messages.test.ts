import { describe, expect, it } from 'vitest';
import {
  type GatewayMessageDefinition,
  gatewayMessageDefinitionSchema,
  validateGatewayMessageOverrides,
} from './gateway-messages.js';

function first<T>(items: T[]): T {
  const item = items[0];
  if (!item) throw new Error('Missing test fixture');
  return item;
}

const definition: GatewayMessageDefinition = {
  version: 1,
  channels: [
    { id: 'status', label: { en: 'Status', it: 'Stato' }, maxLength: 80, multiline: false },
    {
      id: 'announcement',
      label: { en: 'Announcement', it: 'Annuncio' },
      maxLength: 160,
      multiline: true,
    },
  ],
  states: [
    {
      id: 'queued',
      label: { en: 'Queued', it: 'In coda' },
      defaults: {
        en: { status: 'Position {position}', announcement: '{region}' },
        it: { status: 'Posizione {position}', announcement: '{region}' },
      },
      previewVariables: {
        en: { position: '3', region: 'North' },
        it: { position: '3', region: 'Nord' },
      },
    },
    {
      id: 'storm',
      label: { en: 'Storm', it: 'Tempesta' },
      defaults: { en: { status: 'Delayed' }, it: { status: 'In ritardo' } },
      previewVariables: { en: {}, it: {} },
    },
  ],
  variables: [
    { id: 'position', label: { en: 'Position', it: 'Posizione' } },
    { id: 'region', label: { en: 'Region', it: 'Regione' } },
  ],
};

describe('Integration-owned Gateway message contracts', () => {
  it('supports a status-only game with no Minecraft states, channels, variables or formatting', () => {
    const statusOnly = {
      ...definition,
      channels: [definition.channels[0]],
      states: [definition.states[1]],
      variables: [],
    };
    expect(gatewayMessageDefinitionSchema.parse(statusOnly).channels).toHaveLength(1);
    expect(
      validateGatewayMessageOverrides(gatewayMessageDefinitionSchema.parse(statusOnly), {
        storm: { status: 'All clear' },
      }),
    ).toEqual({ storm: { status: 'All clear' } });
    expect(() =>
      validateGatewayMessageOverrides(gatewayMessageDefinitionSchema.parse(statusOnly), {
        sleeping: { motd: '{server}' },
      }),
    ).toThrow();
  });
  it('allows declared extra channels, states and variables with per-channel limits', () => {
    expect(
      validateGatewayMessageOverrides(definition, {
        queued: { status: 'At {position}', announcement: 'Region:\n{region}' },
        storm: { status: 'Delayed' },
      }),
    ).toBeTruthy();
    for (const overrides of [
      { missing: { status: 'x' } },
      { queued: { motd: 'x' } },
      { storm: { announcement: 'x' } },
      { queued: { status: 'x'.repeat(81) } },
      { queued: { status: 'one\ntwo' } },
      { queued: { status: '{server}' } },
      { queued: { status: '{{position}}' } },
      { queued: { status: 'x\u0000' } },
    ])
      expect(() => validateGatewayMessageOverrides(definition, overrides)).toThrow();
  });
  it('rejects duplicate IDs/tokens, unknown metadata keys, unbalanced locale keys and invalid limits', () => {
    const mutate = (change: (copy: GatewayMessageDefinition) => void) => {
      const copy = structuredClone(definition);
      change(copy);
      return copy;
    };
    for (const bad of [
      mutate((copy) => {
        copy.channels.push(first(copy.channels));
      }),
      mutate((copy) => {
        copy.states.push(first(copy.states));
      }),
      mutate((copy) => {
        copy.variables.push(first(copy.variables));
      }),
      mutate((copy) => {
        first(copy.states).defaults.it = { status: 'x' };
      }),
      mutate((copy) => {
        first(copy.states).defaults.en.other = 'x';
        first(copy.states).defaults.it.other = 'x';
      }),
      mutate((copy) => {
        first(copy.states).previewVariables.en.secret = 'x';
        first(copy.states).previewVariables.it.secret = 'x';
      }),
      mutate((copy) => {
        first(copy.channels).maxLength = 4097;
      }),
      mutate((copy) => {
        first(copy.states).defaults.en.status = 'one\ntwo';
      }),
      mutate((copy) => {
        first(copy.channels).formatting = {
          tokens: [{ value: '\u0000', label: { en: 'A', it: 'A' } }],
        };
      }),
      mutate((copy) => {
        first(copy.states).defaults.en.status = 'x'.repeat(81);
      }),
      mutate((copy) => {
        first(copy.channels).formatting = {
          caseInsensitive: true,
          tokens: [
            { value: '~a', label: { en: 'A', it: 'A' } },
            { value: '~A', label: { en: 'A', it: 'A' } },
          ],
        };
      }),
      { ...definition, unknown: true },
    ])
      expect(gatewayMessageDefinitionSchema.safeParse(bad).success).toBe(false);
  });
  it('preserves legacy Owner literal/empty defaults while validating user template variables', () => {
    const copy = structuredClone(definition);
    first(copy.states).defaults.en.status = '';
    first(copy.states).defaults.it.status = '{literal owner text}';
    expect(first(gatewayMessageDefinitionSchema.parse(copy).states).defaults.en.status).toBe('');
    expect(() =>
      validateGatewayMessageOverrides(copy, { queued: { status: '{literal owner text}' } }),
    ).toThrow();
  });
});
