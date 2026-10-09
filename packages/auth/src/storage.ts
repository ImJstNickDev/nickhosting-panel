import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new DomainError('conflict');
    }
    throw error;
  } finally {
    tx.release();
  }
}

export async function writeAudit(
  tx: Pick<PoolClient, 'query'>,
  input: {
    actorUserId: string | null;
    subjectUserId: string | null;
    action: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    'INSERT INTO audit_events(id, actor_user_id, subject_user_id, action, correlation_id, metadata) VALUES($1,$2,$3,$4,$5,$6)',
    [
      randomUUID(),
      input.actorUserId,
      input.subjectUserId,
      input.action,
      input.correlationId ?? randomUUID(),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

/** Database-backed throttling survives restarts and is shared by all API processes. */
export async function throttle(pool: Pool, key: string, maximum = 5, seconds = 300): Promise<void> {
  const result = await pool.query<{ attempts: number }>(
    `
    INSERT INTO identity_throttle(key, attempts, window_start) VALUES($1,1,now())
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN identity_throttle.window_start < now() - ($2 * interval '1 second') THEN 1 ELSE identity_throttle.attempts + 1 END,
      window_start = CASE WHEN identity_throttle.window_start < now() - ($2 * interval '1 second') THEN now() ELSE identity_throttle.window_start END
    RETURNING attempts`,
    [key, seconds],
  );
  if ((result.rows[0]?.attempts ?? maximum + 1) > maximum) throw new DomainError('rate_limited');
}
