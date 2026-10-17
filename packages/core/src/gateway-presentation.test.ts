import { describe, expect, it } from 'vitest';
import {
  gatewayMessageOverridesSchema,
  gatewayPresentationSchema,
} from './gateway-presentation.js';

describe('Generic Gateway message transport', () => {
  it('preserves arbitrary integration state/channel data and leaves template semantics to the integration', () => {
    const messages = { queued: { status: '{position}\nReady soon', announcement: '§a{world}' } };
    expect(gatewayMessageOverridesSchema.parse(messages)).toEqual(messages);
    expect(
      gatewayPresentationSchema.parse({
        serverName: 'Demo',
        messages,
        stopping: true,
        blockedReason: 'capacity_denied',
        estimatedStartupSeconds: 10,
      }),
    ).toMatchObject({ messages, stopping: true });
  });
  it('rejects unsafe identifiers, controls, unbounded records and excessive text', () => {
    for (const input of [
      { 'bad state': { status: 'x' } },
      { queued: { constructor: 'x' } },
      { queued: { status: '\u0000' } },
      { queued: { status: 'x'.repeat(4097) } },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`state${i}`, {}])),
      { queued: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`channel${i}`, 'x'])) },
      Object.fromEntries(
        Array.from({ length: 2 }, (_, i) => [
          `state${i}`,
          Object.fromEntries(
            Array.from({ length: 16 }, (_, j) => [`channel${j}`, 'x'.repeat(4096)]),
          ),
        ]),
      ),
    ])
      expect(gatewayMessageOverridesSchema.safeParse(input).success).toBe(false);
  });
});
