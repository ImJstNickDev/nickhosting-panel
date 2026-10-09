import { getCurrentAdapter } from '@better-auth/core/context';
import { passkey } from '@better-auth/passkey';
import type { BetterAuthPlugin } from 'better-auth';
import { betterAuth } from 'better-auth';
import {
  APIError,
  addOAuthServerContext,
  createAuthMiddleware,
  getOAuthState,
} from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import type { IdentityOptions } from './contracts.js';
import { tokenHash } from './crypto.js';
import { writeAudit } from './storage.js';

const invitationPlugin = {
  id: 'nickhosting-invitation-schema',
  schema: {
    invitation: {
      fields: {
        tokenHash: { type: 'string', required: true, unique: true, returned: false },
        remainingUses: { type: 'number', required: true, returned: false },
        maxUses: { type: 'number', required: true },
        expiresAt: { type: 'date', required: true },
        revokedAt: { type: 'date', required: false },
        email: { type: 'string', required: false },
        role: { type: 'string', required: true },
        createdAt: { type: 'date', required: true },
        createdBy: { type: 'string', required: true, references: { model: 'user', field: 'id' } },
      },
    },
  },
} satisfies BetterAuthPlugin;

interface InvitationRecord {
  id: string;
  email: string | null;
  role: 'user' | 'operator';
}
const denied = () =>
  new APIError('BAD_REQUEST', { code: 'INVITATION_INVALID', message: 'errors.invitation_invalid' });
const isPlaceholder = (email: string) => email.endsWith('@discord.placeholder.invalid');
const localeOf = (user: object): 'en' | 'it' =>
  'locale' in user && user.locale === 'it' ? 'it' : 'en';

export function buildBetterAuth(options: IdentityOptions) {
  return betterAuth({
    appName: 'NickHosting',
    baseURL: options.baseURL,
    basePath: '/api/auth',
    secret: options.authSecret,
    database: options.pool,
    trustedOrigins: [
      ...new Set([
        new URL(options.baseURL).origin,
        new URL(options.publicURL ?? options.baseURL).origin,
      ]),
    ],
    logger: { disabled: true }, // Auth failures must go through the application's redacted logger.
    onAPIError: { throw: true },
    advanced: {
      // The API boundary removes incoming values and supplies the socket peer address.
      // Never trust browser-controlled X-Forwarded-For or X-Real-IP for throttling.
      ipAddress: { ipAddressHeaders: ['x-nh-client-ip'] },
      useSecureCookies: new URL(options.baseURL).protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      database: { generateId: 'uuid' },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    user: {
      additionalFields: {
        role: { type: ['owner', 'operator', 'user'], defaultValue: 'user', input: false },
        locale: { type: ['en', 'it'], defaultValue: options.defaultLocale ?? 'en', input: true },
      },
      changeEmail: { enabled: true },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        if (!isPlaceholder(user.email))
          await options.mail({
            to: user.email,
            template: 'reset-password',
            url,
            locale: localeOf(user),
          });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        if (!isPlaceholder(user.email))
          await options.mail({
            to: user.email,
            template: 'verify-email',
            url,
            locale: localeOf(user),
          });
      },
    },
    account: {
      storeStateStrategy: 'database',
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        trustedProviders: ['discord'],
        allowUnlinkingAll: false,
      },
    },
    socialProviders: options.discord
      ? {
          discord: {
            ...options.discord,
            mapProfileToUser: (profile) =>
              profile.email
                ? {}
                : {
                    email: `${profile.id}@discord.placeholder.invalid`,
                    emailVerified: false,
                  },
          },
        }
      : {},
    session: {
      expiresIn: options.sessionTtlSeconds ?? 60 * 60 * 24 * 7,
      freshAge: 300,
      cookieCache: { enabled: false },
    },
    plugins: [
      invitationPlugin,
      twoFactor({
        issuer: 'NickHosting',
        allowPasswordless: true,
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 },
      }),
      passkey({
        rpID: new URL(options.publicURL ?? options.baseURL).hostname,
        rpName: 'NickHosting',
        origin: new URL(options.publicURL ?? options.baseURL).origin,
        registration: {
          requireSession: true,
          afterVerification: async ({ verification }) => {
            if (!verification.registrationInfo?.userVerified)
              throw new APIError('UNAUTHORIZED', {
                code: 'FAILED_TO_VERIFY_REGISTRATION',
                message: 'errors.forbidden',
              });
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified)
              throw new APIError('UNAUTHORIZED', {
                code: 'AUTHENTICATION_FAILED',
                message: 'errors.forbidden',
              });
          },
        },
        authenticatorSelection: { userVerification: 'required' },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // No invitation fields from client-controlled OAuth additionalData are trusted.
        if (ctx.path === '/sign-in/social') {
          const invite = ctx.headers?.get('x-invitation-token');
          if (invite && invite.length <= 256)
            await addOAuthServerContext({ invitationHash: tokenHash(invite) });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (!ctx) throw denied();
            if (ctx.path === '/sign-up/email' && isPlaceholder(user.email)) throw denied();
            const state = await getOAuthState();
            const trustedHash = state?.serverContext?.invitationHash;
            const headerToken =
              ctx.path === '/sign-up/email' ? ctx.headers?.get('x-invitation-token') : null;
            const hash =
              typeof trustedHash === 'string'
                ? trustedHash
                : headerToken && headerToken.length <= 256
                  ? tokenHash(headerToken)
                  : null;
            if (!hash) throw denied();
            // MUST use the current Better Auth transaction, never a separate pool transaction.
            const tx = await getCurrentAdapter(ctx.context.adapter);
            const invitation = await tx.findOne<InvitationRecord>({
              model: 'invitation',
              where: [{ field: 'tokenHash', value: hash }],
            });
            if (!invitation || (invitation.email && invitation.email !== user.email.toLowerCase()))
              throw denied();
            // Credential signup is pending local verification; an OAuth session is immediate.
            // A provider's unverified matching address is not proof for an email-bound invite.
            if (invitation.email && ctx.path !== '/sign-up/email' && !user.emailVerified)
              throw denied();
            const consumed = await tx.incrementOne<InvitationRecord>({
              model: 'invitation',
              where: [
                { field: 'tokenHash', value: hash },
                { field: 'revokedAt', value: null },
                { field: 'expiresAt', operator: 'gt', value: new Date() },
                { field: 'remainingUses', operator: 'gt', value: 0 },
              ],
              increment: { remainingUses: -1 },
            });
            if (!consumed) throw denied();
            return { data: { ...user, role: invitation.role } };
          },
          after: async (user) => {
            await writeAudit(options.pool, {
              actorUserId: user.id,
              subjectUserId: user.id,
              action: 'identity.registered',
            });
          },
        },
      },
      account: {
        create: {
          after: async (account) => {
            await writeAudit(options.pool, {
              actorUserId: account.userId,
              subjectUserId: account.userId,
              action: 'identity.account_linked',
              metadata: { provider: account.providerId },
            });
          },
        },
        delete: {
          after: async (account) => {
            await writeAudit(options.pool, {
              actorUserId: account.userId,
              subjectUserId: account.userId,
              action: 'identity.account_unlinked',
              metadata: { provider: account.providerId },
            });
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await writeAudit(options.pool, {
              actorUserId: session.userId,
              subjectUserId: session.userId,
              action: 'identity.session_created',
              metadata: { sessionId: session.id },
            });
          },
        },
        delete: {
          after: async (session) => {
            await writeAudit(options.pool, {
              actorUserId: session.userId,
              subjectUserId: session.userId,
              action: 'identity.session_revoked',
              metadata: { sessionId: session.id },
            });
          },
        },
      },
    },
  });
}
