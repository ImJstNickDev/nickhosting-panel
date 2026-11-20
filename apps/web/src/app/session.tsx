import { queryOptions, useQuery } from '@tanstack/react-query';
import { ApiError, api, queryClient, readApi } from '../api/client.js';
import { clearFileListing } from '../features/file-listing-storage.js';
import type { WebSession } from './session-schema.js';

export type { WebSession } from './session-schema.js';
// Include both sides of an assisted session in private query cache keys.
export function webSessionScope(session: WebSession | undefined) {
  const context = session?.context;
  return [
    context?.actorUserId,
    context?.subjectUserId,
    context?.role,
    context?.sessionType,
    context?.support?.id,
  ];
}
export const publicSetupQuery = queryOptions({
  queryKey: ['setup'],
  networkMode: 'always',
  queryFn: ({ signal }) =>
    readApi<{ ownerClaimed: boolean; completed: boolean }>('/v1/setup', signal),
});
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    networkMode: 'always',
    queryFn: async ({ signal }) => {
      const [value, { sessionSchema }] = await Promise.all([
        readApi('/v1/web/session', signal),
        import('./session-schema.js'),
      ]);
      return sessionSchema.parse(value);
    },
    refetchInterval: 30000,
    retry: false,
  });
}
export function useWebConfig() {
  return useQuery({
    queryKey: ['web-config'],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: () =>
      api<{
        instanceName: string;
        defaultLocale: 'en' | 'it';
        supportSessionPresent: boolean;
        auth: { email: boolean; discord: boolean; passkey: boolean; totp: boolean };
      }>('/v1/web/config'),
  });
}
export async function identityChanged() {
  await queryClient.cancelQueries();
  clearFileListing();
  queryClient.removeQueries({ type: 'inactive' });
  await queryClient.resetQueries({ type: 'active' });
}
export function isSignedOut(error: unknown) {
  return error instanceof ApiError && ['unauthenticated', 'email_unverified'].includes(error.code);
}
