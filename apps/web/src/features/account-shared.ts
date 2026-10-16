import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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

export function useSecuritySetup() {
  const [codes, setCodes] = useState<string[]>([]);
  const [totpURI, setTotpURI] = useState<string>();
  return { codes, setCodes, totpURI, setTotpURI };
}
