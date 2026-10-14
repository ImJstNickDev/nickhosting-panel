import { expect, it } from 'vitest';
import { resolveConfig } from './config.js';

it('validates Minecraft responder presentation through normal Owner/environment precedence', () => {
  expect(resolveConfig().values.minecraftGatewayResponses).toBeUndefined();
  const config = resolveConfig(
    { minecraftGatewayResponses: { legacyProtocol: 51 } },
    {
      NH_MINECRAFT_GATEWAY_RESPONSES: JSON.stringify({
        legacyProtocol: 61,
        maximumPlayers: 20,
        motd: { sleeping: { en: 'Sleeping', it: 'Sospeso' } },
      }),
    },
  );
  expect(config.values.minecraftGatewayResponses?.legacyProtocol).toBe(61);
  expect(config.sources.minecraftGatewayResponses).toBe('environment');
  for (const value of [
    { legacyProtocol: 256 },
    { onlinePlayers: -1 },
    { legacyLineSeparator: '\n' },
    { fallbackProtocol: -1 },
    { unknown: true },
  ])
    expect(() => resolveConfig({ minecraftGatewayResponses: value })).toThrow(
      'configuration_invalid',
    );
});
