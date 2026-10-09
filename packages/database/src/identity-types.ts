import type { Generated } from 'kysely';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: Generated<boolean>;
  image: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  role: Generated<'owner' | 'operator' | 'user'>;
  locale: Generated<'en' | 'it'>;
  twoFactorEnabled: Generated<boolean>;
}
export interface AuthSession {
  id: string;
  expiresAt: Date;
  token: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
  ipAddress: string | null;
  userAgent: string | null;
  userId: string;
}
export interface AuthAccount {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scope: string | null;
  password: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}
export interface AuthTables {
  user: AuthUser;
  session: AuthSession;
  account: AuthAccount;
  verification: {
    id: string;
    identifier: string;
    value: string;
    expiresAt: Date;
    createdAt: Generated<Date>;
    updatedAt: Generated<Date>;
  };
  twoFactor: {
    id: string;
    secret: string;
    backupCodes: string;
    userId: string;
    verified: Generated<boolean>;
    failedVerificationCount: Generated<number>;
    lockedUntil: Date | null;
  };
  passkey: {
    id: string;
    name: string | null;
    publicKey: string;
    userId: string;
    credentialID: string;
    counter: number;
    deviceType: string;
    backedUp: boolean;
    transports: string | null;
    createdAt: Generated<Date>;
    aaguid: string | null;
  };
  rateLimit: { id: string; key: string; count: number; lastRequest: number };
  invitation: {
    id: string;
    tokenHash: string;
    remainingUses: number;
    maxUses: number;
    expiresAt: Date;
    revokedAt: Date | null;
    email: string | null;
    role: 'operator' | 'user';
    createdAt: Generated<Date>;
    createdBy: string;
  };
  instance_setup: {
    id: number;
    owner_user_id: string;
    claimed_at: Generated<Date>;
    completed_at: Date | null;
  };
  step_up_grants: {
    token_hash: string;
    user_id: string;
    session_id: string;
    created_at: Generated<Date>;
    expires_at: Date;
  };
  support_sessions: {
    id: string;
    token_hash: string;
    actor_user_id: string;
    subject_user_id: string;
    parent_session_id: string;
    reason: string;
    origin: string;
    audit_correlation_id: string;
    started_at: Generated<Date>;
    expires_at: Date;
    last_activity_at: Generated<Date>;
    revoked_at: Date | null;
  };
  audit_events: {
    id: string;
    actor_user_id: string | null;
    subject_user_id: string | null;
    action: string;
    correlation_id: string;
    metadata: Generated<Record<string, unknown>>;
    created_at: Generated<Date>;
  };
  email_credential_claims: {
    token_hash: string;
    user_id: string;
    session_id: string;
    email: string;
    password_hash: string;
    expires_at: Date;
  };
  identity_throttle: { key: string; attempts: number; window_start: Date };
}
