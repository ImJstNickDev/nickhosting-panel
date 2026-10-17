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
