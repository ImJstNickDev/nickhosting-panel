import type { GatewaySnapshot } from '@nickhosting/game-sdk';

export function gatewayClientFeatures(header: string | undefined): Set<string> {
  return new Set(header?.split(',').map((feature) => feature.trim()) ?? []);
}

/** Legacy Gateways strictly decode presentation fields, including receipt snapshots. */
export function gatewayPresentationForClient(
  snapshot: GatewaySnapshot,
  header: string | undefined,
): GatewaySnapshot {
  if (gatewayClientFeatures(header).has('presentation-variables-v1')) return snapshot;
  return {
    ...snapshot,
    routes: snapshot.routes.map((route) => {
      if (!route.presentation) return route;
      const { variables: _variables, ...presentation } = route.presentation;
      return { ...route, presentation };
    }),
  };
}
