import { type AuthContext, DomainError } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import { z } from 'zod';
import type { DB, Environment } from './admission.js';
import { ownerOnly } from './registry.js';

export const openworldNoticeSchema = z.strictObject({
  noticeSeconds: z.int().min(1).max(86400),
});

function environmentNotice(env: Environment) {
  const raw = env.NH_OPENWORLD_UPDATE_NOTICE_SECONDS;
  if (raw === undefined || raw === '') return undefined;
  const parsed = openworldNoticeSchema.shape.noticeSeconds.safeParse(Number(raw));
  if (!/^\d+$/.test(raw) || !parsed.success) throw new DomainError('configuration_invalid');
  return parsed.data;
}

export async function getOpenworldUpdateNoticeSeconds(db: DB, env: Environment = {}) {
  const override = environmentNotice(env);
  if (override !== undefined) return override;
  const row = await db
    .selectFrom('openworld_update_settings')
    .select('notice_seconds')
    .where('singleton', '=', true)
    .executeTakeFirst();
  return row?.notice_seconds ?? 60;
}

export async function openworldUpdateSettings(db: DB, env: Environment) {
  return {
    noticeSeconds: await getOpenworldUpdateNoticeSeconds(db, env),
    locked: environmentNotice(env) !== undefined,
  };
}

export async function setOpenworldUpdateNotice(
  db: DB,
  who: AuthContext,
  env: Environment,
  noticeSeconds: number,
) {
  ownerOnly(who);
  if (environmentNotice(env) !== undefined) throw new DomainError('conflict');
  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('openworld_update_settings')
      .values({ singleton: true, notice_seconds: noticeSeconds })
      .onConflict((c) => c.column('singleton').doUpdateSet({ notice_seconds: noticeSeconds }))
      .execute();
    await recordAudit(tx, who, 'openworld.update_notice.changed', { noticeSeconds });
  });
  return { noticeSeconds, locked: false };
}
