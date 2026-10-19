import { type AuthContext, assertAuthContext, DomainError } from '@nickhosting/core';
import { sql } from 'kysely';
import { z } from 'zod';
import type { DB } from './admission.js';
import { provisioningPresentation } from './provisioning.js';
import { parse } from './registry.js';

export const activityCategories = [
  'lifecycle',
  'files',
  'backups',
  'access',
  'settings',
  'console',
] as const;
export const activityOutcomes = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'requested',
  'uncertain',
  'partial',
  'cancelled',
  'dispatched',
] as const;
type Outcome = (typeof activityOutcomes)[number];
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(1024).optional(),
    serverId: z.uuid().optional(),
    state: z.enum(activityOutcomes).optional(),
    category: z.enum(activityCategories).optional(),
    action: z.string().max(100).optional(),
    actorId: z.string().min(1).max(128).optional(),
    source: z.enum(['manual', 'system', 'schedule', 'sftp']).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to));

// Deliberately enumerate user-visible server events. Owner security/infrastructure
// audit events must never become visible merely because metadata contains a serverId.
const auditCategories: Record<string, (typeof activityCategories)[number]> = {
  'server.files.requested': 'files',
  'server.upload.batch_prepared': 'files',
  'server.upload.started': 'files',
  'server.upload.confirmed': 'files',
  'server.upload.not_dispatched': 'files',
  'server.upload.not_published': 'files',
  'server.upload.cancelled': 'files',
  'server.upload.uncertain': 'files',
  'server.upload.entry_cancelled': 'files',
  'server.upload.batch_closed': 'files',

  'server.files.completed': 'files',
  'server.files.incomplete': 'files',
  'server.files.uploaded': 'files',
  'server.files.failed': 'files',
  'server.files.cancelled': 'files',
  'server.sftp.file.upload': 'files',
  'server.sftp.file.download': 'files',
  'server.sftp.file.delete': 'files',
  'server.sftp.file.rename': 'files',
  'server.sftp.file.mkdir': 'files',
  'server.sftp.file.rmdir': 'files',
  'server.sftp.file.copy': 'files',
  'server.console.command': 'console',
  'server.console.dispatched': 'console',
  'server.console.failed': 'console',
  'server.backup.updated': 'backups',
  'server.backup.delete_requested': 'backups',
  'server.backup.deleted': 'backups',
  'server.backup.delete_incomplete': 'backups',
  'server.sftp.issued': 'access',
  'server.member.updated': 'access',
  'server.sftp.rotated': 'access',
  'server.sftp.revoked': 'access',
  'server.sftp.access_revoked': 'access',
  'server.sftp.password_revealed': 'access',
  'server.metadata.updated': 'settings',
  'server.automation_consent.updated': 'settings',
  'server.dns.assigned': 'settings',
  'server.dns.updated': 'settings',
  'server.dns.deleted': 'settings',
  'gateway.policy.updated': 'settings',
  'gateway.messages.updated': 'settings',
  'server.auto_wake_policy.updated': 'settings',
  'gateway.route.configured': 'settings',
  'gateway.consent.revoked': 'settings',
  'schedule.created': 'settings',
  'schedule.updated': 'settings',
  'schedule.deleted': 'settings',
  'schedule.stop_consent_revoked': 'settings',
};

export interface PlatformActivity {
  id: string;
  kind: 'job' | 'audit';
  jobId: string | null;
  state: Outcome;
  outcome: Outcome;
  category: (typeof activityCategories)[number];
  source: 'manual' | 'system' | 'schedule' | 'sftp';
  action: string | null;
  actorId: string | null;
  subjectId: string | null;
  actor: { id: string; name: string | null; username: string | null } | null;
  subject: { id: string; name: string | null; username: string | null } | null;
  resourceOwnerId: string;
  serverId: string | null;
  serverName: string | null;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  phase: string | null;
  effectState: string | null;
  provisioning?: { stage: string; state: string };
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
  messageKey: string;
}

/** Never serialize arbitrary provider metadata, errors, contents or output. */
function safeMetadata(raw: Record<string, unknown>, canManage: boolean) {
  const result: Record<string, unknown> = {};
  for (const key of [
    'operationId',
    'batchId',
    'action',
    'path',
    'root',
    'target',
    'credentialUsername',
    'memberName',
    'memberUsername',
    'role',
  ]) {
    if (typeof raw[key] === 'string') result[key] = raw[key].slice(0, 4096);
  }
  if (canManage && typeof raw.command === 'string') result.command = raw.command.slice(0, 4096);
  for (const key of ['count', 'bytes', 'completed', 'failed', 'cancelled', 'uncertain']) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  const entry = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const value = input as Record<string, unknown>;
    const selected: Record<string, unknown> = {};
    for (const key of ['id', 'path', 'target'])
      if (typeof value[key] === 'string') selected[key] = value[key].slice(0, 4096);
    if (
      typeof value.state === 'string' &&
      ['pending', 'uploading', 'active', 'complete', ...activityOutcomes].includes(value.state)
    )
      selected.state = value.state === 'active' ? 'running' : value.state;
    if (typeof value.bytes === 'number' && Number.isFinite(value.bytes) && value.bytes >= 0)
      selected.bytes = value.bytes;
    return selected;
  };
  if (Array.isArray(raw.entries))
    result.entries = raw.entries.slice(0, 100).map(entry).filter(Boolean);
  if (raw.entry) result.entry = entry(raw.entry);
  return result;
}

export async function listUnifiedActivity(db: DB, context: AuthContext, input: unknown = {}) {
  assertAuthContext(context);
  const value = parse(querySchema, input);
  let after: { at: string; id: string } | undefined;
  if (value.cursor) {
    try {
      after = parse(
        z
          .object({ at: z.iso.datetime(), id: z.string().regex(/^(audit:)?[0-9a-f-]{36}$/) })
          .strict(),
        JSON.parse(Buffer.from(value.cursor, 'base64url').toString('utf8')),
      );
    } catch {
      throw new DomainError('validation_failed');
    }
  }
  const allServers = context.role === 'owner' && context.sessionType === 'regular';
  const scope = sql`(${allServers} or server.owner_id = ${context.subjectUserId} or exists (
    select 1 from project_members member where member.project_id = server.project_id and member.user_id = ${context.subjectUserId}
  ))`;
  // Match the existing list/detail boundary (including support subject scoping).
  if (value.serverId) {
    const visible =
      await sql`select server.id from managed_servers server where server.id = ${value.serverId} and server.deleted_at is null and ${scope}`.execute(
        db,
      );
    if (!visible.rows.length) throw new DomainError('not_found');
  }
  const categoryCases = sql.join(
    Object.entries(auditCategories).map(
      ([action, category]) => sql`when ${action} then ${category}`,
    ),
    sql` `,
  );
  const filters = [sql`true`];
  const candidateFilters = [sql`true`];
  if (value.serverId) filters.push(sql`"serverId" = ${value.serverId}`);
  if (value.state) filters.push(sql`state = ${value.state}`);
  if (value.category) filters.push(sql`category = ${value.category}`);
  if (value.action)
    filters.push(
      sql`(action = ${value.action} or metadata->>'action' = ${value.action} or action = ${`server.sftp.file.${value.action}`})`,
    );
  if (value.actorId) {
    filters.push(sql`"actorId" = ${value.actorId}`);
    candidateFilters.push(sql`actor_user_id = ${value.actorId}`);
  }
  if (value.source) filters.push(sql`source = ${value.source}`);
  if (value.from) {
    filters.push(sql`"createdAt" >= ${new Date(value.from)}`);
    candidateFilters.push(sql`first_at >= ${new Date(value.from)}`);
  }
  if (value.to) {
    filters.push(sql`"createdAt" <= ${new Date(value.to)}`);
    candidateFilters.push(sql`first_at <= ${new Date(value.to)}`);
  }
  if (after) {
    filters.push(
      sql`(date_trunc('milliseconds', "createdAt"), id) < (${new Date(after.at)}, ${after.id})`,
    );
    candidateFilters.push(
      sql`(date_trunc('milliseconds', first_at), id) < (${new Date(after.at)}, ${after.id})`,
    );
  }
  if (value.q)
    filters.push(
      sql`(strpos(lower(concat_ws(' ', action, "serverName", "actorName", "actorUsername", metadata->>'action', metadata->>'path', metadata->>'root', metadata->>'target', metadata->>'credentialUsername', case when "canManage" then metadata->>'command' end)), lower(${value.q})) > 0 or exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(metadata->'entries') = 'array' then metadata->'entries' else '[]'::jsonb end) entry
        where strpos(lower(concat_ws(' ', entry->>'path', entry->>'target')), lower(${value.q})) > 0
      ))`,
    );
  const groupId = sql`coalesce(nullif(audit.metadata->>'operationId',''), nullif(audit.metadata->>'batchId',''), audit.id::text)`;
  const terminalOrder = sql`case when audit.metadata->>'outcome' = 'requested' or audit.action in ('server.files.requested', 'server.console.command', 'server.backup.delete_requested', 'server.upload.batch_prepared', 'server.upload.started') then 0 else 1 end`;
  const eligibleAudit = sql`audit.metadata ? 'serverId' and audit.action in (${sql.join(Object.keys(auditCategories))})
    and (audit.action not like 'server.upload.%' or nullif(audit.metadata->>'operationId', '') is not null or nullif(audit.metadata->>'batchId', '') is not null)
    and not exists (select 1 from server_operations op where op.server_id::text = audit.metadata->>'serverId' and op.job_id::text = audit.metadata->>'jobId')`;
  // Metadata-heavy snapshots never participate in the history grouping/sort.
  // Default/actor/time pages hydrate at most limit+1 audit groups. Filters on
  // current outcome/content must examine latest snapshots before applying LIMIT.
  const needsSnapshotFilter =
    value.state || value.category || value.action || value.source || value.q;
  const candidateLimit = needsSnapshotFilter ? sql`` : sql`limit ${value.limit + 1}`;
  type Row = Omit<PlatformActivity, 'actor' | 'subject' | 'outcome' | 'messageKey'> & {
    actorName: string | null;
    actorUsername: string | null;
    subjectName: string | null;
    subjectUsername: string | null;
    canManage: boolean;
    installationPlan: Record<string, unknown> | null;
  };
  const rows = (
    await sql<Row>`
    with visible_servers as (
      select server.*, (${context.role === 'owner'} or server.owner_id = ${context.subjectUserId} or exists (
        select 1 from project_members member where member.project_id = server.project_id and member.user_id = ${context.subjectUserId} and member.role in ('owner', 'manager')
      )) as can_manage from managed_servers server where ${scope} ${value.serverId ? sql`and server.id = ${value.serverId}` : sql``}
    ), audit_scoped as (
      select audit.id, audit.actor_user_id, audit.subject_user_id, audit.created_at,
        server.id::text as server_id, ${groupId} as group_id,
        (nullif(audit.metadata->>'operationId','') is not null or nullif(audit.metadata->>'batchId','') is not null) as grouped
      from audit_events audit join visible_servers server on server.id::text = audit.metadata->>'serverId'
      where ${eligibleAudit}
    ), audit_keys as (
      select server_id, group_id, actor_user_id, subject_user_id, min(created_at) as first_at,
        'audit:' || case when bool_or(grouped)
          then md5(jsonb_build_array(server_id, group_id, actor_user_id, subject_user_id)::text)::uuid::text
          else group_id end as id
      from audit_scoped group by server_id, group_id, actor_user_id, subject_user_id
    ), audit_candidates as materialized (
      select * from audit_keys where ${sql.join(candidateFilters, sql` and `)}
      order by date_trunc('milliseconds', first_at) desc, id desc ${candidateLimit}
    ), audit_grouped as (
      select keys.id as activity_id, keys.first_at, latest.created_at as last_at,
        latest.metadata, latest.action, keys.actor_user_id, keys.subject_user_id,
        first.metadata as initial_metadata, server.owner_id, server.name as server_name, server.can_manage
      from audit_candidates keys join visible_servers server on server.id::text = keys.server_id
      cross join lateral (
        select audit.metadata, audit.action, audit.created_at from audit_events audit
        where audit.metadata->>'serverId' = keys.server_id and ${groupId} = keys.group_id
          and coalesce(audit.actor_user_id, '') = coalesce(keys.actor_user_id, '')
          and coalesce(audit.subject_user_id, '') = coalesce(keys.subject_user_id, '') and ${eligibleAudit}
        order by audit.created_at desc, ${terminalOrder} desc, audit.id desc limit 1
      ) latest
      cross join lateral (
        select audit.metadata from audit_events audit
        where audit.metadata->>'serverId' = keys.server_id and ${groupId} = keys.group_id
          and coalesce(audit.actor_user_id, '') = coalesce(keys.actor_user_id, '')
          and coalesce(audit.subject_user_id, '') = coalesce(keys.subject_user_id, '') and ${eligibleAudit}
        order by audit.created_at, ${terminalOrder}, audit.id limit 1
      ) first
    ), combined as (
      select job.id::text as id, 'job'::text as kind, job.id::text as "jobId", job.state,
        case when operation.action in ('backup','restore') then 'backups' when operation.action in ('configure','minecraft-content') then 'settings' else 'lifecycle' end as category,
        case when operation.plan ? 'scheduleAutomation' or job.idempotency_key like 'schedule_%' then 'schedule' when operation.plan ? 'gatewayAutomation' or job.idempotency_key like 'gateway_wake_%' or job.idempotency_key like 'gateway_sleep_%' then 'system' else 'manual' end as source,
        operation.action, job.actor_id as "actorId", job.subject_id as "subjectId", actor.name as "actorName", actor.username as "actorUsername", subject.name as "subjectName", subject.username as "subjectUsername",
        job.resource_owner_id as "resourceOwnerId", operation.server_id as "serverId", server.name as "serverName",
        job.attempts, job.max_attempts as "maxAttempts", job.error_code as "errorCode", operation.phase, operation.effect_state as "effectState",
        job.created_at as "createdAt", job.updated_at as "updatedAt", job.completed_at as "completedAt", '{}'::jsonb as metadata, coalesce(server.can_manage, false) as "canManage", case when operation.action in ('provision','reinstall') then jsonb_build_object('provisioning',operation.plan->'provisioning','installConfirmed',operation.plan->'installConfirmed','initialStartDenied',operation.plan->'initialStartDenied','waitReason',operation.plan->'waitReason','autoStart',operation.plan->'autoStart') else null end as "installationPlan"
      from operation_jobs job left join server_operations operation on operation.job_id = job.id
      left join visible_servers server on server.id = operation.server_id left join "user" actor on actor.id = job.actor_id left join "user" subject on subject.id = job.subject_id
      where server.id is not null or (operation.server_id is null and (${allServers} or job.resource_owner_id = ${context.subjectUserId}))
      union all
      select audit.activity_id, 'audit', null,
        case when audit.metadata->>'outcome' in (${sql.join(activityOutcomes)}) then audit.metadata->>'outcome'
          when audit.metadata->>'outcome' = 'partial_or_uncertain' or audit.action in ('server.files.incomplete', 'server.backup.delete_incomplete', 'server.upload.uncertain') then 'uncertain'
          when audit.action in ('server.files.requested', 'server.console.command', 'server.backup.delete_requested', 'server.sftp.issued', 'server.sftp.rotated', 'server.sftp.revoked', 'server.sftp.access_revoked', 'server.upload.started', 'server.upload.batch_prepared') then 'requested'
          when audit.action = 'server.console.dispatched' then 'dispatched'
          when audit.action in ('server.files.failed', 'server.console.failed') then 'failed'
          when audit.action = 'server.files.cancelled' then 'cancelled' else 'succeeded' end,
        case audit.action ${categoryCases} end,
        case when audit.metadata->>'source' = 'sftp' then 'sftp' when audit.metadata->>'source' = 'schedule' then 'schedule' when audit.metadata->>'source' = 'system' or audit.actor_user_id is null then 'system' else 'manual' end,
        audit.action, audit.actor_user_id, audit.subject_user_id, actor.name, actor.username, subject.name, subject.username,
        audit.owner_id, (audit.metadata->>'serverId')::uuid, audit.server_name,
        0, 0, null, null, null, audit.first_at, audit.last_at, null, (case when audit.metadata ? 'entry' then audit.initial_metadata - 'entries' else audit.initial_metadata end) || audit.metadata, audit.can_manage, null
      from audit_grouped audit left join "user" actor on actor.id = audit.actor_user_id left join "user" subject on subject.id = audit.subject_user_id
    ) select * from combined where ${sql.join(filters, sql` and `)}
    order by date_trunc('milliseconds', "createdAt") desc, id desc limit ${value.limit + 1}
  `.execute(db)
  ).rows;
  const items: PlatformActivity[] = rows
    .slice(0, value.limit)
    .map(
      ({
        actorName,
        actorUsername,
        subjectName,
        subjectUsername,
        canManage,
        installationPlan,
        ...row
      }) => ({
        ...row,
        ...(installationPlan
          ? {
              provisioning: (() => {
                const progress = provisioningPresentation({
                  job_id: row.jobId ?? '',
                  action: row.action ?? '',
                  phase: row.phase ?? '',
                  plan: installationPlan,
                  effect_state: row.effectState ?? '',
                  state: row.state,
                  error_code: row.errorCode,
                  created_at: row.createdAt,
                  updated_at: row.updatedAt,
                  completed_at: row.completedAt,
                });
                return { stage: progress.stage, state: progress.state };
              })(),
            }
          : {}),
        metadata: safeMetadata(row.metadata, canManage),
        actor: row.actorId ? { id: row.actorId, name: actorName, username: actorUsername } : null,
        subject: row.subjectId
          ? { id: row.subjectId, name: subjectName, username: subjectUsername }
          : null,
        outcome: row.state,
        messageKey: `${row.kind === 'job' ? 'jobs' : 'activity.state'}.${row.state}`,
      }),
    );
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > value.limit && last
        ? Buffer.from(JSON.stringify({ at: last.createdAt.toISOString(), id: last.id })).toString(
            'base64url',
          )
        : null,
  };
}
