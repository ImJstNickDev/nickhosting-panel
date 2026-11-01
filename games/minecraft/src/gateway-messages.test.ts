import { describe, expect, it } from 'vitest';
import { gatewayMessageState, renderGatewayMessage } from './gateway-messages.js';

describe('Minecraft Gateway presentation', () => {
  it('separates disabled wake and capacity failures without changing operational states', () => {
    expect(gatewayMessageState('sleeping', false)).toBe('wake_disabled');
    expect(gatewayMessageState('stopping', false)).toBe('stopping');
    expect(
      gatewayMessageState('blocked', true, {
        serverName: 'Demo',
        messages: {},
        blockedReason: 'capacity_denied',
      }),
    ).toBe('capacity_denied');
    expect(gatewayMessageState('online', true)).toBeUndefined();
  });
  it('renders startup estimate only while positive and never recursively interprets server names', () => {
    const presentation = {
      serverName: '{eta}',
      messages: {},
      estimatedStartupSeconds: 10,
      startupBeganAt: '2026-10-17T10:00:00Z',
    };
    expect(
      renderGatewayMessage(
        '{server}: {eta}',
        'waking',
        'en',
        presentation,
        Date.parse('2026-10-17T10:00:03Z'),
      ),
    ).toBe('{eta}: 7 s');
    expect(
      renderGatewayMessage(
        '{eta}',
        'waking',
        'en',
        presentation,
        Date.parse('2026-10-17T10:00:15Z'),
      ),
    ).toBe('');
    expect(renderGatewayMessage('{eta}', 'sleeping', 'en', presentation)).toBe('');
  });
});

it('preserves Minecraft Owner defaults, server-name previews and protocol formatting metadata', async () => {
  const { minecraftGatewayMessages, resolveMinecraftGatewayMessages } = await import(
    './gateway-messages.js'
  );
  const { validateGatewayMessageOverrides } = await import('@nickhosting/game-sdk');
  const resolved = resolveMinecraftGatewayMessages(
    {
      motd: { sleeping: { en: '§a{server}', it: '' } },
      disconnect: { waking: { en: 'Owner {literal}', it: 'Attendi' } },
    },
    '{eta}',
  );
  expect(resolved.states.find((state) => state.id === 'sleeping')?.defaults).toEqual({
    en: { motd: '§a{server}', disconnect: 'Server sleeping. Join to start it.' },
    it: { motd: '', disconnect: 'Server in sospensione. Connettiti per avviarlo.' },
  });
  expect(resolved.states.find((state) => state.id === 'waking')?.defaults.en.disconnect).toBe(
    'Owner {literal}',
  );
  expect(resolved.states[0]?.previewVariables.en).toMatchObject({ server: '{eta}', eta: '' });
  expect(minecraftGatewayMessages.channels[0]?.formatting).toMatchObject({ caseInsensitive: true });
  expect(
    minecraftGatewayMessages.channels[0]?.formatting?.tokens.find((token) => token.value === '§a'),
  ).toMatchObject({ reset: true, style: { color: '#55ff55' } });
  expect(
    validateGatewayMessageOverrides(minecraftGatewayMessages, {
      sleeping: { motd: '§A{server}\n{state}', disconnect: 'Wait {eta}' },
    }),
  ).toBeTruthy();
  for (const input of [
    { ready: { motd: 'x' } },
    { sleeping: { motd: '{secret}' } },
    { sleeping: { motd: 'x'.repeat(513) } },
  ])
    expect(() => validateGatewayMessageOverrides(minecraftGatewayMessages, input)).toThrow();
});

it('uses literal bounded context values for all new variables without recursive substitution', async () => {
  const { resolveMinecraftGatewayMessages, minecraftGatewayRuntimeName } = await import(
    './gateway-messages.js'
  );
  const variables = {
    version: '26.1',
    runtime: 'vanilla',
    address: '{version}.example.test',
  };
  const presentation = {
    serverName: 'World {elapsed}',
    messages: {},
    variables,
    startupBeganAt: '2026-10-17T10:00:00Z',
  };
  const now = Date.parse('2026-10-17T10:00:03.900Z');
  const template = '{server}|{version}|{runtime}|{address}|{elapsed}|{eta}';
  expect(renderGatewayMessage(template, 'waking', 'en', presentation, now)).toBe(
    'World {elapsed}|26.1|Vanilla|{version}.example.test|3 s|',
  );
  expect(renderGatewayMessage('{elapsed}|{eta}', 'sleeping', 'en', presentation, now)).toBe('|');
  expect(renderGatewayMessage('{version}|{runtime}|{address}|{elapsed}', 'waking', 'en')).toBe(
    '|||',
  );
  expect(renderGatewayMessage('{elapsed}', 'waking', 'it', presentation, now - 10000)).toBe('0 s');
  const definition = resolveMinecraftGatewayMessages(
    undefined,
    presentation.serverName,
    presentation,
    now,
  );
  const preview = definition.states.find((state) => state.id === 'waking')?.previewVariables;
  expect(preview?.en).toMatchObject({ ...variables, runtime: 'Vanilla', elapsed: '3 s', eta: '' });
  expect(preview?.it).toMatchObject({ ...variables, runtime: 'Vanilla', elapsed: '3 s', eta: '' });
  expect(minecraftGatewayRuntimeName('constructor')).toBe('');
  expect(minecraftGatewayRuntimeName('unknown')).toBe('');
  const { validateGatewayMessageOverrides } = await import('@nickhosting/game-sdk');
  expect(
    validateGatewayMessageOverrides(definition, {
      waking: { motd: template, disconnect: template },
    }),
  ).toBeTruthy();
});

it('applies MOTD alignment after expansion but never interprets variable values as controls', async () => {
  const { minecraftGatewayMessages } = await import('./gateway-messages.js');
  const { validateGatewayMessageOverrides } = await import('@nickhosting/game-sdk');
  const presentation = { serverName: 'AAA', messages: {} };
  expect(renderGatewayMessage('[align=center]{server}', 'sleeping', 'en', presentation)).toBe(
    `§r${' '.repeat(31)}AAA`,
  );
  expect(
    renderGatewayMessage('{server}', 'sleeping', 'en', {
      ...presentation,
      serverName: '[align=right]AAA',
    }),
  ).toBe('[align=right]AAA');
  expect(
    renderGatewayMessage('[align=center]{server}', 'sleeping', 'en', presentation, 0, 'disconnect'),
  ).toBe('[align=center]AAA');
  expect(
    minecraftGatewayMessages.channels
      .find((channel) => channel.id === 'motd')
      ?.formatting?.tokens.filter((token) => token.value.startsWith('[align=')),
  ).toHaveLength(2);
  expect(
    minecraftGatewayMessages.channels
      .find((channel) => channel.id === 'disconnect')
      ?.formatting?.tokens.some((token) => token.value.startsWith('[align=')),
  ).toBe(false);
  expect(
    validateGatewayMessageOverrides(minecraftGatewayMessages, {
      sleeping: { motd: '[align=right]§a{server}' },
    }),
  ).toBeTruthy();
});
