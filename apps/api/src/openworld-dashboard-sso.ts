import { createHash, randomBytes } from 'node:crypto';
import { type AuthContext, authSessionId, DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { dashboardHostname } from '@nickhosting/external-services';
import { resolveOpenworldPublication } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { Variables } from './app.js';

export const callbackPath = '/.nickhosting/callback';
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const requestSchema = z.strictObject({
  hostname: z.string().refine(dashboardHostname),
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
});

type DB = Kysely<Database>;
// The native interface is an explicit administrative grant. Platform roles and
// legacy/project permissions alone do not convey this game credential.
const hasDashboard = sql<boolean>`(s.owner_id = p."userId" OR EXISTS (
  SELECT 1 FROM server_subusers su WHERE su.server_id = s.id AND su.user_id = p."userId"
  AND su.permission_keys @> '["game.openworld.dashboard.admin"]'::jsonb))`;

const hasAccess = sql<boolean>`(${hasDashboard} OR EXISTS (
  SELECT 1 FROM server_subusers su WHERE su.server_id = s.id AND su.user_id = p."userId"
  AND su.permission_keys @> '["game.openworld.seed.inspect"]'::jsonb))`;

export async function publishedInspectorLink(db: DB, who: AuthContext, id: string) {
  const result = await sql<{ hostname: string; allowed: boolean }>`SELECT d.hostname,
    (p.id IS NOT NULL AND ${hasAccess}) AS allowed
    FROM openworld_dashboard_dns d
    JOIN openworld_dashboard_publications pub ON pub.server_id=d.server_id
    JOIN managed_servers s ON s.id=d.server_id
    LEFT JOIN session p ON p.id=${who[authSessionId] ?? ''} AND p."userId"=${who.subjectUserId} AND p."expiresAt">now()
    WHERE d.server_id=${id}::uuid AND pub.enabled AND pub.state='active'
      AND pub.tracked_hostname=d.hostname AND pub.proxy_host_id IS NOT NULL`.execute(db);
  const row = result.rows[0];
  if (!row || !dashboardHostname(row.hostname))
    return { inspectorUrl: null, inspectorPublished: false };
  const allowed =
    row.allowed && who.sessionType === 'regular' && who.actorUserId === who.subjectUserId;
  return {
    inspectorUrl: allowed ? new URL('/inspector/', `https://${row.hostname}`).href : null,
    inspectorPublished: true,
  };
}

export async function issueDashboardCode(
  db: DB,
  who: AuthContext,
  args: z.infer<typeof requestSchema>,
  lookup = resolveOpenworldPublication,
) {
  const parent = who[authSessionId];
  if (who.sessionType !== 'regular' || who.subjectUserId !== who.actorUserId || !parent)
    throw new DomainError('forbidden');
  const route = await lookup(db, args.hostname);
  if (!route) throw new DomainError('not_found');
  const code = randomToken();
  const issued = await db.transaction().execute(async (tx) => {
    await sql`DELETE FROM openworld_dashboard_sessions WHERE expires_at <= now()`.execute(tx);
    return sql`INSERT INTO openworld_dashboard_sessions
      (token_hash, parent_id, server_id, hostname, challenge, expires_at)
      SELECT ${digest(code)}, p.id, s.id, ${args.hostname}, ${args.challenge}, least(p."expiresAt", now() + interval '60 seconds')
      FROM session p JOIN managed_servers s ON s.id = ${route.serverId}::uuid
      WHERE p.id = ${parent} AND p."userId" = ${who.subjectUserId}
        AND p."expiresAt" > now() AND s.deleted_at IS NULL AND ${hasAccess}
      RETURNING parent_id`.execute(tx);
  });
  if (!issued.rows.length) throw new DomainError('forbidden');
  const redirect = new URL(callbackPath, `https://${args.hostname}`);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', args.challenge);
  return { redirectUrl: redirect.href };
}

export function registerOpenworldDashboardSso(
  app: Hono<{ Variables: Variables }>,
  db: DB,
  principal: (c: Context<{ Variables: Variables }>, regular?: boolean) => Promise<AuthContext>,
) {
  app.post('/v1/web/openworld/dashboard/authorize', async (c) => {
    const who = await principal(c, true);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DomainError('validation_failed');
    return c.json(await issueDashboardCode(db, who, parsed.data));
  });
}

export async function exchangeDashboardCode(
  db: DB,
  hostname: string,
  serverId: string,
  code: string,
  nonce: string,
) {
  const token = randomToken();
  // Changing the primary key consumes the code in the same locked UPDATE.
  const result = await sql`UPDATE openworld_dashboard_sessions g
    SET token_hash = ${digest(token)}, challenge = NULL,
      expires_at = least(p."expiresAt", now() + interval '12 hours')
    FROM session p, managed_servers s
    WHERE g.token_hash = ${digest(code)} AND g.hostname = ${hostname}
      AND g.server_id = ${serverId}::uuid AND g.challenge = ${digest(nonce)}
      AND p.id = g.parent_id AND p."expiresAt" > now() AND g.expires_at > now()
      AND s.id = g.server_id AND s.deleted_at IS NULL AND ${hasAccess}
    RETURNING g.parent_id`.execute(db);
  return result.rows.length ? token : undefined;
}

export async function dashboardSessionBinding(
  db: DB,
  hostname: string,
  serverId: string,
  token: string,
) {
  const result = await sql<{
    provider: string | null;
    mapping: string;
    node: string;
    allocation: string | null;
    address: string | null;
    port: number | null;
    running: boolean;
    dashboard: boolean;
  }>`SELECT s.pterodactyl_uuid AS provider, s.mapping_id AS mapping, s.node_id AS node,
       a.id AS allocation, a.backend_address AS address, a.port,
       (s.runtime_state = 'running' AND s.installation_state = 'installed') AS running,
       ${hasDashboard} AS dashboard
     FROM openworld_dashboard_sessions g
     JOIN session p ON p.id = g.parent_id
     JOIN managed_servers s ON s.id = g.server_id
     LEFT JOIN server_allocations a ON a.server_id = s.id AND a.node_id = s.node_id
       AND a.role = 'dashboard' AND a.private_only AND a.direct_endpoint IS NULL AND 'tcp' = ANY(a.protocols)
     WHERE g.token_hash = ${digest(token)} AND g.challenge IS NULL
       AND g.hostname = ${hostname} AND g.server_id = ${serverId}::uuid
       AND p."expiresAt" > now() AND g.expires_at > now() AND s.deleted_at IS NULL AND ${hasAccess}`.execute(
    db,
  );
  return result.rows[0];
}
