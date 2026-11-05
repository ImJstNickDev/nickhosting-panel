import { DomainError } from '@nickhosting/core';
import type { GameRuntimeHandler, ServerPlan } from '@nickhosting/game-sdk';
import { z } from 'zod';

export const satisfactorySteamAppId = '1690800';
export const satisfactoryCertificatePaths = {
  certificate: 'FactoryGame/Certificates/cert_chain.pem',
  privateKey: 'FactoryGame/Certificates/private_key.pem',
} as const;
export const satisfactoryConfigurationSchema = z.strictObject({
  branch: z.enum(['public', 'experimental']).default('public'),
  autoUpdate: z.boolean().default(true),
});
export const satisfactoryPorts = [
  { role: 'game', transport: 'both', required: true },
  { role: 'reliable', transport: 'tcp', required: true },
] as const;
export function buildSatisfactoryPlan(
  configuration: Readonly<Record<string, unknown>>,
  gameVersion: string,
): ServerPlan {
  const parsed = satisfactoryConfigurationSchema.safeParse(configuration);
  if (!parsed.success || !/^[a-zA-Z0-9._-]{1,64}$/.test(gameVersion))
    throw new DomainError('validation_failed');
  return {
    gameId: 'satisfactory',
    runtimeId: 'dedicated',
    gameVersion,
    configuration: parsed.data,
    ports: satisfactoryPorts,
  };
}
export const satisfactoryRuntime: GameRuntimeHandler = {
  id: 'dedicated',
  configurationSchema: satisfactoryConfigurationSchema,
  async buildPlan(configuration, gameVersion) {
    return buildSatisfactoryPlan(configuration, gameVersion);
  },
};
export function satisfactoryPortArguments(ports: {
  game: number;
  reliable: number;
  externalReliable: number;
}): string[] {
  if (
    Object.values(ports).some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
    ports.game === ports.reliable
  )
    throw new DomainError('configuration_invalid');
  return [
    `-Port=${ports.game}`,
    `-ReliablePort=${ports.reliable}`,
    `-ExternalReliablePort=${ports.externalReliable}`,
  ];
}
export function satisfactoryEggEnvironment(
  configuration: Readonly<Record<string, unknown>>,
  ports: { game: number; reliable: number; externalReliable: number },
): Record<string, string> {
  satisfactoryPortArguments(ports);
  const parsed = satisfactoryConfigurationSchema.parse(configuration);
  return {
    STEAM_APP_ID: satisfactorySteamAppId,
    SRCDS_APPID: satisfactorySteamAppId,
    SRCDS_BETAID: parsed.branch === 'public' ? '' : parsed.branch,
    AUTO_UPDATE: parsed.autoUpdate ? '1' : '0',
    SERVER_PORT: String(ports.game),
    RELIABLE_PORT: String(ports.reliable),
    EXTERNAL_RELIABLE_PORT: String(ports.externalReliable),
  };
}
