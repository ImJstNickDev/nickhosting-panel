import type { EncryptedSecret } from '@nickhosting/core';
import type { Generated } from 'kysely';

export interface ProviderAccountTables {
  provider_accounts: {
    user_id: string;
    instance_id: string | null;
    provider_url: string | null;
    provider_id: number | null;
    provider_uuid: string | null;
    external_id: string | null;
    key_operation_id: Generated<string>;
    key_identifier: string | null;
    key_envelope: EncryptedSecret | null;
    status: Generated<'pending' | 'provisioning' | 'ready' | 'failed'>;
    attempts: Generated<number>;
    lease_token: string | null;
    lease_until: Date | null;
    retry_at: Generated<Date>;
    last_error: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
