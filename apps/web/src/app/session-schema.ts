import { z } from 'zod';

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
export const sessionSchema = z.object({
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
