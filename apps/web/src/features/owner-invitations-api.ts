import { z } from 'zod';
import { api } from '../api/client.js';

const invitationSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  role: z.enum(['user', 'operator']),
  remainingUses: z.number().int().nonnegative(),
  maxUses: z.number().int().min(1).max(100),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  createdAt: z.string().optional(),
  linkAvailable: z.boolean().optional(),
});
export type Invitation = z.infer<typeof invitationSchema>;
const linkSchema = z.object({
  url: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
});
const createdSchema = linkSchema.extend({
  id: z.string(),
  expiresAt: z.string(),
  linkAvailable: z.boolean().optional(),
});
export interface InvitationInput {
  email?: string;
  role: 'user' | 'operator';
  maxUses: number;
  expiresAt?: string;
}
const endpoint = (id: string) => `/v1/owner/invitations/${encodeURIComponent(id)}`;

// Invitation URLs are fetched on demand and never stored in the query cache.
export const invitationApi = {
  list: async (signal: AbortSignal) =>
    z.array(invitationSchema).parse(await api('/v1/owner/invitations', { signal })),
  create: async (body: InvitationInput) =>
    createdSchema.parse(await api('/v1/owner/invitations', { body })),
  link: async (id: string, signal: AbortSignal) =>
    linkSchema.parse(await api(`${endpoint(id)}/link`, { signal })),
  update: async (id: string, body: { expiresAt: string; maxUses: number }) =>
    invitationSchema.parse(await api(endpoint(id), { method: 'PATCH', body })),
  revoke: async (id: string) => api(endpoint(id), { method: 'DELETE' }),
};
