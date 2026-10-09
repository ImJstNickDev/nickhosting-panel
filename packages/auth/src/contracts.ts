import type { DiscordOptions } from 'better-auth/social-providers';
import type { Pool, PoolClient } from 'pg';

export interface IdentityMail {
  to: string;
  template: 'verify-email' | 'reset-password' | 'link-email';
  url: string;
  locale: 'en' | 'it';
}
export interface SetupSettings {
  instanceName: string;
  pterodactylBaseURL: string;
  pterodactylApplicationKey: string;
  pterodactylClientKey?: string;
}
export interface IdentityOptions {
  pool: Pool;
  baseURL: string;
  publicURL?: string;
  defaultLocale?: 'en' | 'it';
  registrationInviteTtlSeconds?: number;
  sessionTtlSeconds?: number;
  supportIdleTtlSeconds?: number;
  supportAbsoluteTtlSeconds?: number;
  authSecret: string;
  bootstrapToken?: string;
  mail: (message: IdentityMail) => Promise<void>;
  discord?: Pick<DiscordOptions, 'clientId' | 'clientSecret' | 'getUserInfo'>;
  /** Validates the connection and writes settings/secrets in the supplied transaction. */
  completeSetup: (tx: PoolClient, input: SetupSettings, actorUserId: string) => Promise<void>;
}
