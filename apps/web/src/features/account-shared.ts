import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, queryClient } from '../api/client.js';
import { useSession } from '../app/session.js';

export async function refreshAccount() {
  await queryClient.invalidateQueries({ queryKey: ['session'] });
  await queryClient.invalidateQueries({ queryKey: ['account'] });
}

export function useLinkedAccounts() {
  const session = useSession();
  const ordinary = session.data?.context.sessionType === 'regular';
  return useQuery({
    queryKey: ['account', 'links'],
    queryFn: () => api<Array<{ id: string; providerId: string }>>('/api/auth/list-accounts'),
    enabled: ordinary,
  });
}

export type TwoFactorStep = 'confirm' | 'authenticator' | 'recovery' | 'disable' | 'codes';

/** Layout-owned memory: survives tab changes, never persisted in a cache or storage. */
export function useSecuritySetup() {
  const [codes, setCodes] = useState<string[]>([]);
  const [totpURI, setTotpURI] = useState<string>();
  const [step, setStep] = useState<TwoFactorStep>();
  const [confirmedEnabled, setConfirmedEnabled] = useState<{ value: boolean; at: number }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const inFlight = useRef(false);
  async function run(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return {
    confirmedEnabled,
    setConfirmedEnabled,
    codes,
    setCodes,
    totpURI,
    setTotpURI,
    step,
    setStep,
    pending,
    error,
    setError,
    run,
  };
}
