import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { ConnectionChoice, ConnectionOptions } from './connection.api.js';
export type ConnectionAvailabilityState =
  | 'automatic'
  | 'unchecked'
  | 'checking'
  | 'available'
  | 'taken'
  | 'unavailable'
  | 'invalid';
export const validSubdomain = (label: string) =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
export function useConnectionAvailability(
  gameId: string,
  options: ConnectionOptions | undefined,
  choice: ConnectionChoice,
  enabled: boolean,
) {
  const label = choice.subdomain ?? '';
  const domainId = choice.domainId ?? options?.defaultDomainId ?? options?.domains[0]?.id;
  const key = JSON.stringify([gameId, domainId, label]);
  const automatic = !label || options?.customizable === false;
  const valid = validSubdomain(label);
  const [result, setResult] = useState<{
    key: string;
    state: ConnectionAvailabilityState;
    hostname?: string;
  }>();
  useEffect(() => {
    if (!enabled || automatic || !valid || !options?.configured || !domainId) return;
    const controller = new AbortController();
    let current = true;
    const timer = setTimeout(async () => {
      setResult({ key, state: 'checking' });
      try {
        const response = await api<{ available: boolean; hostname: string }>(
          `/v1/games/${encodeURIComponent(gameId)}/connection-availability`,
          { body: { domainId, subdomain: label }, signal: controller.signal },
        );
        if (current)
          setResult({
            key,
            state: response.available ? 'available' : 'taken',
            hostname: response.hostname,
          });
      } catch {
        if (current) setResult({ key, state: 'unavailable' });
      }
    }, 600);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [gameId, domainId, label, key, automatic, valid, options?.configured, enabled]);
  const state: ConnectionAvailabilityState = automatic
    ? 'automatic'
    : !valid
      ? 'invalid'
      : result?.key === key
        ? result.state
        : 'unchecked';
  return {
    state,
    hostname: result?.key === key ? result.hostname : undefined,
    canContinue: automatic || (options?.configured === true && state === 'available'),
  };
}
