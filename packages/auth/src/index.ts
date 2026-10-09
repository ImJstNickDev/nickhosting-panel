import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@nickhosting/core';
import { assertPermission, DomainError } from '@nickhosting/core';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { buildBetterAuth } from './better-auth.js';
import type { IdentityOptions } from './contracts.js';
import { equalToken, opaqueToken, tokenHash } from './crypto.js';
import { throttle, transaction, writeAudit } from './storage.js';

export type { IdentityMail, IdentityOptions, SetupSettings } from './contracts.js';
export { writeAudit } from './storage.js';

const email = z
  .email()
  .toLowerCase()
  .refine((value) => !value.endsWith('.invalid'));
const password = z.string().min(12).max(128);
const token = z.string().min(20).max(256);
const setupSchema = z
  .object({
    instanceName: z.string().trim().min(1).max(100),
    pterodactylBaseURL: z.url(),
    pterodactylApplicationKey: z.string().min(16).max(4096),
    pterodactylClientKey: z.string().min(16).max(4096).optional(),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError('validation_failed');
  return result.data;
}

export function createIdentity(options: IdentityOptions) {
  const { pool } = options;
  const publicURL = options.publicURL ?? options.baseURL;
  const defaultLocale = options.defaultLocale ?? 'en';
  if (defaultLocale !== 'en' && defaultLocale !== 'it')
    throw new DomainError('configuration_invalid');
  const inviteTtlSeconds = options.registrationInviteTtlSeconds ?? 86_400;
  if (!Number.isInteger(inviteTtlSeconds) || inviteTtlSeconds < 60 || inviteTtlSeconds > 31_536_000)
    throw new DomainError('configuration_invalid');
  const idleTtlSeconds = options.supportIdleTtlSeconds ?? 300;
  const absoluteTtlSeconds = options.supportAbsoluteTtlSeconds ?? 900;
  if (
    !Number.isInteger(idleTtlSeconds) ||
    idleTtlSeconds < 1 ||
    idleTtlSeconds > 900 ||
    !Number.isInteger(absoluteTtlSeconds) ||
    absoluteTtlSeconds < 1 ||
    absoluteTtlSeconds > 3600
  )
    throw new DomainError('configuration_invalid');
  if (
    options.authSecret.length < 32 ||
    (options.bootstrapToken && options.bootstrapToken.length < 32)
  )
    throw new DomainError('configuration_invalid');
  const auth = buildBetterAuth(options);

  async function regular(headers: Headers) {
    const session = await auth.api.getSession({ headers });
    if (!session || session.session.expiresAt <= new Date())
      throw new DomainError('unauthenticated');
    // Cookie cache is disabled. Re-fetch role from the authority on every request.
    const result = await pool.query<{
      role: 'owner' | 'operator' | 'user';
      emailVerified: boolean;
      email: string;
      twoFactorEnabled: boolean;
      locale: 'en' | 'it';
    }>('SELECT role,"emailVerified",email,"twoFactorEnabled",locale FROM "user" WHERE id=$1', [
      session.user.id,
    ]);
    const user = result.rows[0];
    if (!user) throw new DomainError('unauthenticated');
    const context: AuthContext = {
      actorUserId: session.user.id,
      subjectUserId: session.user.id,
      role: user.role,
      sessionType: 'regular',
      ownerElevation: false,
    };
    return { context, sessionId: session.session.id, session, user };
  }
  async function owner(headers: Headers) {
    const result = await regular(headers);
    if (result.context.role !== 'owner' || !result.user.emailVerified)
      throw new DomainError('forbidden');
    return result;
  }

  async function authenticate(
    headers: Headers,
    supportToken?: string,
  ): Promise<{ context: AuthContext; sessionId: string; locale: 'en' | 'it' }> {
    const parent = await regular(headers);
    if (!supportToken)
      return { context: parent.context, sessionId: parent.sessionId, locale: parent.user.locale };
    if (parent.context.role !== 'owner') throw new DomainError('support_invalid');
    const result = await pool.query<{
      id: string;
      subject_user_id: string;
      reason: string;
      started_at: Date;
      expires_at: Date;
      last_activity_at: Date;
      revoked_at: Date | null;
      subject_locale: 'en' | 'it' | null;
    }>(
      `UPDATE support_sessions SET last_activity_at=now()
      WHERE token_hash=$1 AND parent_session_id=$2 AND actor_user_id=$3 AND revoked_at IS NULL
      AND expires_at>now() AND last_activity_at>now()-($4 * interval '1 second')
      AND started_at>now()-($5 * interval '1 second')
      RETURNING id,subject_user_id,reason,started_at,expires_at,last_activity_at,revoked_at,
      (SELECT locale FROM "user" WHERE "user".id=support_sessions.subject_user_id) AS subject_locale`,
      [
        tokenHash(supportToken),
        parent.sessionId,
        parent.context.actorUserId,
        idleTtlSeconds,
        absoluteTtlSeconds,
      ],
    );
    const support = result.rows[0];
    if (!support) throw new DomainError('support_expired');
    return {
      sessionId: parent.sessionId,
      locale: support.subject_locale ?? parent.user.locale,
      context: {
        ...parent.context,
        subjectUserId: support.subject_user_id,
        sessionType: 'support',
        ownerElevation: true,
        support: {
          id: support.id,
          reason: support.reason,
          startedAt: support.started_at,
          expiresAt: support.expires_at,
          lastActivityAt: support.last_activity_at,
          revokedAt: support.revoked_at,
          idleTtlSeconds,
          absoluteTtlSeconds,
        },
      },
    };
  }

  async function bootstrapStatus() {
    const result = await pool.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM instance_setup WHERE id=1',
    );
    return {
      ownerClaimed: result.rowCount === 1,
      completed: Boolean(result.rows[0]?.completed_at),
    };
  }
  async function claimOwner(raw: unknown) {
    const input = parse(
      z
        .object({
          token,
          name: z.string().trim().min(1).max(100),
          email,
          password,
          locale: z.enum(['en', 'it']).default(defaultLocale),
        })
        .strict(),
      raw,
    );
    await throttle(pool, 'owner-bootstrap', 10, 300);
    if (!options.bootstrapToken || !equalToken(input.token, options.bootstrapToken))
      throw new DomainError('setup_token_invalid');
    const passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    await transaction(pool, async (tx) => {
      // Locks are local to this database; no seed row is required.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('nickhosting:first-owner'))");
      const existing = await tx.query('SELECT id FROM instance_setup WHERE id=1');
      if (existing.rowCount) throw new DomainError('setup_completed');
      await tx.query(
        'INSERT INTO "user"(id,name,email,role,locale) VALUES($1,$2,$3,\'owner\',$4)',
        [id, input.name, input.email, input.locale],
      );
      await tx.query(
        'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
        [randomUUID(), id, passwordHash],
      );
      await tx.query('INSERT INTO instance_setup(id,owner_user_id) VALUES(1,$1)', [id]);
      await writeAudit(tx, { actorUserId: id, subjectUserId: id, action: 'setup.owner_claimed' });
    });
    // If transport fails, the durable Owner stays claimed; resend-verification recovers.
    await auth.api.sendVerificationEmail({ body: { email: input.email, callbackURL: '/' } });
    return { userId: id, verificationRequired: true };
  }
  async function completeSetup(headers: Headers, raw: unknown) {
    const actor = await owner(headers);
    const input = parse(setupSchema, raw);
    await transaction(pool, async (tx) => {
      const setup = await tx.query<{ completed_at: Date | null; owner_user_id: string }>(
        'SELECT completed_at,owner_user_id FROM instance_setup WHERE id=1 FOR UPDATE',
      );
      if (!setup.rows[0] || setup.rows[0].completed_at) throw new DomainError('setup_completed');
      if (setup.rows[0].owner_user_id !== actor.context.actorUserId)
        throw new DomainError('forbidden');
      await options.completeSetup(tx, input, actor.context.actorUserId);
      await tx.query('UPDATE instance_setup SET completed_at=now() WHERE id=1');
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: actor.context.subjectUserId,
        action: 'setup.completed',
      });
    });
    return { completed: true };
  }

  async function createInvitation(headers: Headers, raw: unknown) {
    const actor = await owner(headers);
    const input = parse(
      z
        .object({
          email: email.optional(),
          role: z.enum(['user', 'operator']).default('user'),
          maxUses: z.number().int().min(1).max(100).default(1),
          expiresAt: z.coerce.date().optional(),
        })
        .strict(),
      raw,
    );
    const expiresAt = input.expiresAt ?? new Date(Date.now() + inviteTtlSeconds * 1000);
    if (expiresAt <= new Date() || expiresAt.getTime() > Date.now() + 31_536_000_000)
      throw new DomainError('validation_failed');
    const value = opaqueToken();
    const id = randomUUID();
    await transaction(pool, async (tx) => {
      await tx.query(
        'INSERT INTO invitation(id,"tokenHash","remainingUses","maxUses","expiresAt",email,role,"createdBy") VALUES($1,$2,$3,$3,$4,$5,$6,$7)',
        [
          id,
          tokenHash(value),
          input.maxUses,
          expiresAt,
          input.email ?? null,
          input.role,
          actor.context.actorUserId,
        ],
      );
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: actor.context.subjectUserId,
        action: 'invitation.created',
        metadata: { invitationId: id, role: input.role, maxUses: input.maxUses },
      });
    });
    return {
      id,
      token: value,
      url: new URL(`/invite/${value}`, publicURL).href,
      expiresAt,
    };
  }
  async function inspectInvitation(value: string) {
    const parsed = parse(token, value);
    const result = await pool.query<{
      expiresAt: Date;
      revokedAt: Date | null;
      remainingUses: number;
    }>('SELECT "expiresAt","revokedAt","remainingUses" FROM invitation WHERE "tokenHash"=$1', [
      tokenHash(parsed),
    ]);
    const invite = result.rows[0];
    if (!invite) throw new DomainError('invitation_invalid');
    if (invite.revokedAt) throw new DomainError('invitation_revoked');
    if (invite.expiresAt <= new Date()) throw new DomainError('invitation_expired');
    if (invite.remainingUses < 1) throw new DomainError('invitation_exhausted');
    return { valid: true, expiresAt: invite.expiresAt };
  }
  async function listInvitations(headers: Headers) {
    await owner(headers);
    return (
      await pool.query(
        'SELECT id,email,role,"remainingUses","maxUses","expiresAt","revokedAt","createdAt" FROM invitation ORDER BY "createdAt" DESC LIMIT 200',
      )
    ).rows;
  }
  async function revokeInvitation(headers: Headers, id: string) {
    const actor = await owner(headers);
    await transaction(pool, async (tx) => {
      const result = await tx.query(
        'UPDATE invitation SET "revokedAt"=coalesce("revokedAt",now()) WHERE id=$1 RETURNING id',
        [id],
      );
      if (!result.rowCount) throw new DomainError('not_found');
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: actor.context.subjectUserId,
        action: 'invitation.revoked',
        metadata: { invitationId: id },
      });
    });
  }

  async function stepUp(headers: Headers, raw: unknown) {
    const actor = await owner(headers);
    const input = parse(
      z
        .object({
          password,
          totpCode: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
          recoveryCode: z.string().min(1).max(100).optional(),
        })
        .strict(),
      raw,
    );
    await throttle(pool, `step-up:${actor.context.actorUserId}`);
    const account = await pool.query<{ password: string }>(
      'SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',
      [actor.context.actorUserId],
    );
    if (
      !account.rows[0]?.password ||
      !(await verifyPassword({ password: input.password, hash: account.rows[0].password }))
    )
      throw new DomainError('forbidden');
    if (actor.user.twoFactorEnabled) {
      try {
        if (input.totpCode) await auth.api.verifyTOTP({ headers, body: { code: input.totpCode } });
        else if (input.recoveryCode)
          await auth.api.verifyBackupCode({ headers, body: { code: input.recoveryCode } });
        else throw new DomainError('forbidden');
      } catch {
        throw new DomainError('forbidden');
      }
    }
    const value = opaqueToken();
    const expiresAt = new Date(Date.now() + 300_000);
    await transaction(pool, async (tx) => {
      await tx.query(
        'INSERT INTO step_up_grants(token_hash,user_id,session_id,expires_at) VALUES($1,$2,$3,$4)',
        [tokenHash(value), actor.context.actorUserId, actor.sessionId, expiresAt],
      );
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: actor.context.subjectUserId,
        action: 'identity.step_up',
      });
    });
    return { token: value, expiresAt };
  }
  async function startSupport(headers: Headers, raw: unknown) {
    const actor = await owner(headers);
    const input = parse(
      z
        .object({
          stepUpToken: token,
          subjectUserId: z.string().min(1).max(128),
          reason: z.string().trim().min(5).max(500),
        })
        .strict(),
      raw,
    );
    if (input.subjectUserId === actor.context.actorUserId) throw new DomainError('support_invalid');
    const value = opaqueToken();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + absoluteTtlSeconds * 1000);
    await transaction(pool, async (tx) => {
      const grant = await tx.query(
        'DELETE FROM step_up_grants WHERE token_hash=$1 AND session_id=$2 AND user_id=$3 AND expires_at>now() RETURNING token_hash',
        [tokenHash(input.stepUpToken), actor.sessionId, actor.context.actorUserId],
      );
      if (!grant.rowCount) throw new DomainError('forbidden');
      if (!(await tx.query('SELECT id FROM "user" WHERE id=$1', [input.subjectUserId])).rowCount)
        throw new DomainError('not_found');
      await tx.query(
        'INSERT INTO support_sessions(id,token_hash,actor_user_id,subject_user_id,parent_session_id,reason,origin,audit_correlation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8)',
        [
          id,
          tokenHash(value),
          actor.context.actorUserId,
          input.subjectUserId,
          actor.sessionId,
          input.reason,
          new URL(options.baseURL).origin,
          expiresAt,
        ],
      );
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: input.subjectUserId,
        action: 'support.started',
        correlationId: id,
        metadata: { reason: input.reason },
      });
    });
    return { id, token: value, expiresAt, idleTtlSeconds };
  }
  async function endSupport(headers: Headers, value: string) {
    const actor = await owner(headers);
    await transaction(pool, async (tx) => {
      const result = await tx.query<{ id: string; subject_user_id: string }>(
        'UPDATE support_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE token_hash=$1 AND actor_user_id=$2 AND parent_session_id=$3 RETURNING id,subject_user_id',
        [tokenHash(value), actor.context.actorUserId, actor.sessionId],
      );
      const support = result.rows[0];
      if (!support) throw new DomainError('support_invalid');
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: support.subject_user_id,
        action: 'support.ended',
        correlationId: support.id,
      });
    });
  }

  async function addEmailPassword(headers: Headers, raw: unknown) {
    const actor = await regular(headers);
    const input = parse(z.object({ email, password }).strict(), raw);
    if (Date.now() - actor.session.session.createdAt.getTime() > 300_000)
      throw new DomainError('forbidden');
    await throttle(pool, `link-email:${actor.context.actorUserId}`);
    const credential = await pool.query(
      'SELECT id FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',
      [actor.context.actorUserId],
    );
    if (credential.rowCount) throw new DomainError('conflict');
    const value = opaqueToken();
    const hash = await hashPassword(input.password);
    await pool.query(
      "INSERT INTO email_credential_claims(token_hash,user_id,session_id,email,password_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')",
      [tokenHash(value), actor.context.actorUserId, actor.sessionId, input.email, hash],
    );
    await options.mail({
      to: input.email,
      template: 'link-email',
      url: new URL(`/account/link-email?token=${value}`, publicURL).href,
      locale: actor.user.locale,
    });
    return { verificationRequired: true };
  }
  async function confirmEmailPassword(headers: Headers, raw: unknown) {
    const actor = await regular(headers);
    const input = parse(z.object({ token }).strict(), raw);
    await throttle(pool, `confirm-email:${actor.context.actorUserId}`, 10);
    await transaction(pool, async (tx) => {
      const claims = await tx.query<{ email: string; password_hash: string }>(
        'DELETE FROM email_credential_claims WHERE token_hash=$1 AND user_id=$2 AND session_id=$3 AND expires_at>now() RETURNING email,password_hash',
        [tokenHash(input.token), actor.context.actorUserId, actor.sessionId],
      );
      const claim = claims.rows[0];
      if (!claim) throw new DomainError('forbidden');
      await tx.query(
        'UPDATE "user" SET email=$1,"emailVerified"=true,"updatedAt"=now() WHERE id=$2',
        [claim.email, actor.context.actorUserId],
      );
      await tx.query(
        'INSERT INTO account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
        [randomUUID(), actor.context.actorUserId, claim.password_hash],
      );
      await tx.query('DELETE FROM email_credential_claims WHERE user_id=$1', [
        actor.context.actorUserId,
      ]);
      await tx.query('DELETE FROM session WHERE "userId"=$1 AND id<>$2', [
        actor.context.actorUserId,
        actor.sessionId,
      ]);
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: actor.context.subjectUserId,
        action: 'identity.email_credential_linked',
      });
    });
    return { linked: true };
  }
  async function setRole(headers: Headers, raw: unknown) {
    const actor = await owner(headers);
    const input = parse(
      z.object({ userId: z.string().min(1), role: z.enum(['operator', 'user']) }).strict(),
      raw,
    );
    await transaction(pool, async (tx) => {
      const result = await tx.query(
        'UPDATE "user" SET role=$1,"updatedAt"=now() WHERE id=$2 AND role<>\'owner\' RETURNING id',
        [input.role, input.userId],
      );
      if (!result.rowCount) throw new DomainError('forbidden');
      await writeAudit(tx, {
        actorUserId: actor.context.actorUserId,
        subjectUserId: input.userId,
        action: 'identity.role_changed',
        metadata: { role: input.role },
      });
    });
  }
  async function listAudit(headers: Headers) {
    const actor = await regular(headers);
    assertPermission(actor.context, 'audit:read');
    return (await pool.query('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200')).rows;
  }

  return {
    auth,
    handler: auth.handler,
    authenticate,
    bootstrapStatus,
    claimOwner,
    completeSetup,
    createInvitation,
    inspectInvitation,
    listInvitations,
    revokeInvitation,
    stepUp,
    startSupport,
    endSupport,
    addEmailPassword,
    confirmEmailPassword,
    setRole,
    listAudit,
  };
}

export type Identity = ReturnType<typeof createIdentity>;
