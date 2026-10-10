import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiError, api, queryClient } from '../api/client.js';

const user = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  locale: z.enum(['en', 'it']),
  role: z.enum(['owner', 'operator', 'user']),
  twoFactorEnabled: z.boolean(),
});
const sessionSchema = z.object({
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
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => sessionSchema.parse(await api('/v1/web/session')),
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
  queryClient.removeQueries({ type: 'inactive' });
  await queryClient.resetQueries({ type: 'active' });
}
export function isSignedOut(error: unknown) {
  return error instanceof ApiError && ['unauthenticated', 'email_unverified'].includes(error.code);
}
