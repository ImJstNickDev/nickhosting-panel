import { queryOptions, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, api, queryClient, readApi } from '../api/client.js';
import { clearFileListing } from '../features/file-listing-cache.js';

const user = z.object({
  id: z.string(),
  name: z.string(),
  // Older running API instances may omit this presentation-only field during rollout.
  username: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
  email: z.string(),
  emailVerified: z.boolean(),
  locale: z.enum(['en', 'it']),
  role: z.enum(['owner', 'operator', 'user']),
  twoFactorEnabled: z.boolean(),
});
const sessionSchema = z.object({
  setup: z.object({ ownerClaimed: z.boolean(), completed: z.boolean() }).optional(),
  context: z.object({
    actorUserId: z.string(),
    subjectUserId: z.string(),
    role: z.enum(['owner', 'operator', 'user']),
    sessionType: z.enum(['regular', 'support']),
    ownerElevation: z.boolean(),
    support: z
      .object({
        id: z.string(),
        expiresAt: z.string(),
        reason: z.string(),
        startedAt: z.string(),
        lastActivityAt: z.string(),
      })
      .passthrough()
      .optional(),
  }),
  actor: user,
  subject: user,
});
export type WebSession = z.infer<typeof sessionSchema>;
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
    queryFn: async ({ signal }) => sessionSchema.parse(await readApi('/v1/web/session', signal)),
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
