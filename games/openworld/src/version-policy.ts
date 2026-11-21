export const openworldGatewayVersion = 'a1.2.9';

export function openworldVersionDelivery(
  version: string,
  configured: { gateway: boolean; direct: boolean },
): 'gateway' | 'direct' | undefined {
  if (configured.gateway && version === openworldGatewayVersion) return 'gateway';
  if (configured.direct) return 'direct';
}
