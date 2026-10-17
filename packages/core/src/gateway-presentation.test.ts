import { describe, expect, it } from 'vitest';
import {
  gatewayMessageOverridesSchema,
  gatewayMessageState,
  renderGatewayMessage,
} from './gateway-presentation.js';

describe('Gateway presentation only', () => {
  it('accepts bounded formatting and known variables but not controls, unknown states or placeholders', () => {
    expect(
      gatewayMessageOverridesSchema.parse({
        sleeping: { motd: '§a{server}\n{state}', disconnect: 'Wait {eta}' },
      }),
    ).toBeTruthy();
    for (const input of [
      { ready: { motd: 'x' } },
      { sleeping: { motd: '{secret}' } },
      { sleeping: { motd: '\u0000' } },
      { sleeping: { motd: 'x'.repeat(513) } },
    ])
      expect(gatewayMessageOverridesSchema.safeParse(input).success).toBe(false);
  });
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
