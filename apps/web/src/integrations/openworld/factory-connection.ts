import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);
const online = () => onlineManager.isOnline();

export function useFactoryConnection(query: { isPaused: boolean; dataUpdatedAt: number }) {
  const connected = useSyncExternalStore(subscribe, online, online);
  const paused = !connected || query.isPaused;
  const [lastBeforeDisconnect, remember] = useState<number | null>(null);
  useEffect(() => {
    if (paused) remember(query.dataUpdatedAt);
  }, [paused, query.dataUpdatedAt]);
  return {
    paused,
    cached: paused || lastBeforeDisconnect === query.dataUpdatedAt,
    receivedAt: query.dataUpdatedAt,
  };
}

export type FactoryConnection = ReturnType<typeof useFactoryConnection>;
