import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api/client.js';
import type { ConnectionChoice, ConnectionOptions } from './connection.api.js';
export type ConnectionAvailabilityState =
  | 'automatic'
  | 'unchecked'
  | 'checking'
  | 'available'
  | 'taken'
  | 'unavailable'
  | 'invalid'
  | 'prohibited'
  | 'required';
export const validSubdomain = (label: string) =>
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
export function useConnectionAvailability(
  gameId: string,
  options: ConnectionOptions | undefined,
  choice: ConnectionChoice,
  enabled: boolean,
  onSuggestion?: (choice: ConnectionChoice) => void,
) {
  const label = choice.subdomain ?? '';
  const domainId = choice.domainId ?? options?.defaultDomainId ?? options?.domains[0]?.id;
  const key = JSON.stringify([gameId, domainId, label]);
  const personal = Boolean(onSuggestion && options?.mode === 'custom-subdomain');
  const automatic = (!label && !personal) || options?.customizable === false;
  const valid = validSubdomain(label);
  const [retryCount, setRetryCount] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    state: ConnectionAvailabilityState;
    hostname?: string;
  }>();
  const resultRef = useRef(result);
  resultRef.current = result;
  const [suggestion, setSuggestion] = useState<{
    key: string;
    pending: boolean;
    failed?: boolean;
  }>();
  const current = useRef({ key, enabled, onSuggestion });
  current.current = { key, enabled, onSuggestion };
  const suggestionController = useRef<AbortController | undefined>(undefined);
  const attempted = useRef(new Set<string>());
  const generate = useCallback(async () => {
    if (!enabled || !personal || !options?.configured || !domainId) return;
    suggestionController.current?.abort();
    const controller = new AbortController();
    suggestionController.current = controller;
    setSuggestion({ key, pending: true });
    try {
      const response = await api<{
        domainId: string;
        subdomain: string;
        hostname: string;
        available: true;
      }>(`/v1/games/${encodeURIComponent(gameId)}/connection-suggestion`, {
        body: { domainId },
        signal: controller.signal,
      });
      if (controller.signal.aborted || current.current.key !== key || !current.current.enabled)
        return;
      // The server already checked this exact suggestion: do not immediately repeat that read.
      const responseKey = JSON.stringify([gameId, response.domainId, response.subdomain]);
      setResult({ key: responseKey, state: 'available', hostname: response.hostname });
      setSuggestion(undefined);
      current.current.onSuggestion?.({
        domainId: response.domainId,
        subdomain: response.subdomain,
      });
    } catch {
      if (!controller.signal.aborted && current.current.key === key && current.current.enabled)
        setSuggestion({ key, pending: false, failed: true });
    }
  }, [enabled, personal, options?.configured, domainId, gameId, key]);
  useEffect(() => {
    if (!enabled || !personal || !options?.configured || !domainId || attempted.current.has(gameId))
      return;
    attempted.current.add(gameId);
    if (!label) void generate();
  }, [enabled, personal, options?.configured, domainId, gameId, label, generate]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: leaving the step must cancel its pending suggestion.
  useEffect(
    () => () => {
      suggestionController.current?.abort();
      if (!label && (!current.current.enabled || current.current.key === key))
        attempted.current.delete(gameId);
      setSuggestion(undefined);
    },
    [key, enabled, label, gameId],
  );
  const retry = () => {
    if (suggestion?.key === key && suggestion.failed && personal) void generate();
    else {
      setSuggestion(undefined);
      setResult(undefined);
      setRetryCount((value) => value + 1);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount explicitly restarts the current availability read.
  useEffect(() => {
    if (!enabled || automatic || !valid || !options?.configured || !domainId) return;
    if (resultRef.current?.key === key && resultRef.current.state === 'available') return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(async () => {
      setResult({ key, state: 'checking' });
      try {
        const response = await api<{ available: boolean; hostname: string }>(
          `/v1/games/${encodeURIComponent(gameId)}/connection-availability`,
          { body: { domainId, subdomain: label }, signal: controller.signal },
        );
        if (active)
          setResult({
            key,
            state: response.available ? 'available' : 'taken',
            hostname: response.hostname,
          });
      } catch (error) {
        if (active)
          setResult({
            key,
            state:
              error instanceof ApiError && error.code === 'validation_failed'
                ? 'prohibited'
                : 'unavailable',
          });
      }
    }, 600);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
    // The result deliberately is not a dependency: responses must not retrigger their request.
  }, [gameId, domainId, label, key, automatic, valid, options?.configured, enabled, retryCount]);
  const pendingSuggestion = suggestion?.key === key && suggestion.pending;
  const state: ConnectionAvailabilityState = pendingSuggestion
    ? 'checking'
    : suggestion?.key === key && suggestion.failed
      ? 'unavailable'
      : automatic
        ? 'automatic'
        : !label && personal
          ? 'required'
          : !valid
            ? 'invalid'
            : result?.key === key
              ? result.state
              : 'unchecked';
  const reset = () => {
    suggestionController.current?.abort();
    attempted.current.clear();
    setSuggestion(undefined);
    setResult(undefined);
  };
  return {
    reset,
    state,
    retry,
    generate,
    canGenerate: personal && options?.configured === true,
    generating: Boolean(pendingSuggestion),
    hostname: result?.key === key ? result.hostname : undefined,
    canContinue: automatic || (options?.configured === true && state === 'available'),
  };
}
