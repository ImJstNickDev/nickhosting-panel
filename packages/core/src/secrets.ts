import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from './errors.js';

const envelopeSchema = z
  .object({
    version: z.literal(1),
    keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    iv: z.string(),
    ciphertext: z.string(),
    tag: z.string(),
  })
  .strict();

export type EncryptedSecret = z.infer<typeof envelopeSchema>;

function decode(value: string, expectedLength?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new DomainError('secret_invalid');
  }
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.toString('base64') !== value ||
    (expectedLength !== undefined && bytes.length !== expectedLength)
  ) {
    throw new DomainError('secret_invalid');
  }
  return bytes;
}

export function encryptionKeyFromBase64(value: string): Buffer {
  return decode(value, 32);
}

/** The caller binds context to a stable secret record ID/name, preventing row swaps. */
export class SecretCodec {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(options: { activeKeyId: string; keys: Readonly<Record<string, Uint8Array>> }) {
    this.activeKeyId = options.activeKeyId;
    for (const [id, key] of Object.entries(options.keys)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || key.byteLength !== 32) {
        throw new DomainError('configuration_invalid');
      }
      this.keys.set(id, Buffer.from(key));
    }
    if (!this.keys.has(this.activeKeyId)) throw new DomainError('configuration_invalid');
  }

  private aad(keyId: string, context: string): Buffer {
    if (!context || context.length > 1024) throw new DomainError('secret_invalid');
    return Buffer.from(JSON.stringify(['nickhosting-secret', 1, keyId, context]), 'utf8');
  }

  encrypt(value: string, context: string): EncryptedSecret {
    if (!value || Buffer.byteLength(value, 'utf8') > 1_048_576)
      throw new DomainError('secret_invalid');
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new DomainError('secret_invalid');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(this.aad(this.activeKeyId, context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      version: 1,
      keyId: this.activeKeyId,
      iv: iv.toString('base64'),
      ciphertext: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(input: unknown, context: string): string {
    try {
      const envelope = envelopeSchema.parse(input);
      const key = this.keys.get(envelope.keyId);
      if (!key || envelope.ciphertext.length > 1_398_104) throw new DomainError('secret_invalid');
      const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
      decipher.setAAD(this.aad(envelope.keyId, context));
      decipher.setAuthTag(decode(envelope.tag, 16));
      return Buffer.concat([
        decipher.update(decode(envelope.ciphertext)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Do not disclose ciphertext, keys or crypto parser errors.
      throw new DomainError('secret_invalid');
    }
  }
}

export interface SecretEnvironment {
  authSecret: string;
  masterKey: Buffer;
  masterKeyId: string;
  setupToken?: string;
  discordClientSecret?: string;
  smtpPassword?: string;
  pterodactylApplicationKey?: string;
  pterodactylClientKey?: string;
}

export function parseSecretEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { requireSetupToken?: boolean } = {},
): SecretEnvironment {
  const secret = z.string().min(32).max(4096);
  const schema = z.object({
    authSecret: secret,
    masterKey: z.string(),
    masterKeyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    setupToken: options.requireSetupToken ? secret : secret.optional(),
    discordClientSecret: z.string().min(1).optional(),
    smtpPassword: z.string().min(1).optional(),
    pterodactylApplicationKey: z.string().min(1).optional(),
    pterodactylClientKey: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse({
    authSecret: env.BETTER_AUTH_SECRET,
    masterKey: env.NH_SECRETS_MASTER_KEY,
    masterKeyId: env.NH_SECRETS_KEY_ID ?? 'primary',
    setupToken: env.NH_SETUP_TOKEN,
    discordClientSecret: env.DISCORD_CLIENT_SECRET,
    smtpPassword: env.SMTP_PASSWORD,
    pterodactylApplicationKey: env.NH_PTERODACTYL_APPLICATION_KEY,
    pterodactylClientKey: env.NH_PTERODACTYL_CLIENT_KEY,
  });
  if (!parsed.success)
    throw new DomainError('configuration_invalid', 400, {
      fields: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  try {
    return { ...parsed.data, masterKey: encryptionKeyFromBase64(parsed.data.masterKey) };
  } catch {
    throw new DomainError('configuration_invalid', 400, { fields: ['masterKey'] });
  }
}
