import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listUnifiedActivity } from './activity.js';
import { getPlatformJob } from './platform-queries.js';
import { createProject, enqueueServerOperation, setProjectMember } from './registry.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
});
afterAll(async () => {
  await database?.destroy();
});
async function audit(
  serverId: string,
  action: string,
  metadata: Record<string, unknown> = {},
  at = new Date(),
  actor: AuthContext = f.context,
) {
  const id = randomUUID();
  await f.db
    .insertInto('audit_events')
    .values({
      id,
      action,
      actor_user_id: actor.actorUserId,
      subject_user_id: actor.subjectUserId,
      correlation_id: randomUUID(),
      metadata: { serverId, ...metadata },
      created_at: at,
    })
    .execute();
  return id;
}

describe('unified activity', () => {
  it('does not expose command text to a direct Activity reader and includes Subusers changes', async () => {
    const serverId = await f.server();
    const peer = await managementFixture(f.db);
    await f.db
      .insertInto('server_subusers')
      .values({
        server_id: serverId,
        user_id: peer.context.actorUserId,
        created_by: f.context.actorUserId,
        permission_keys: JSON.stringify(['activity.read']),
      })
      .execute();
    await audit(serverId, 'server.console.command', { command: 'say private-command' });
    await audit(serverId, 'server.subuser.updated', { memberName: 'Collaborator' });
    const result = await listUnifiedActivity(f.db, peer.context, { serverId });
    expect(result.items.some((item) => item.action === 'server.subuser.updated')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-command');
    expect(
      (await listUnifiedActivity(f.db, peer.context, { serverId, q: 'private-command' })).items,
    ).toEqual([]);
    await f.db
      .updateTable('server_subusers')
      .set({
        permission_keys: JSON.stringify(['activity.read', 'console.read', 'console.command']),
      })
      .where('server_id', '=', serverId)
      .where('user_id', '=', peer.context.actorUserId)
      .execute();
    expect(JSON.stringify(await listUnifiedActivity(f.db, peer.context, { serverId }))).toContain(
      'private-command',
    );
  });

  it('shows plugin publication and recovery only in the authorized server activity', async () => {
    const serverId = await f.server();
    const stranger = await managementFixture(f.db, { interactive: true });
    await audit(serverId, 'minecraft.plugins.applied', { count: 2, outcome: 'succeeded' });
    await audit(serverId, 'minecraft.plugins.preparation_reconciled', { outcome: 'succeeded' });
    const result = await listUnifiedActivity(f.db, f.context, { serverId, category: 'settings' });
    expect(result.items.map((item) => item.action).sort()).toEqual([
      'minecraft.plugins.applied',
      'minecraft.plugins.preparation_reconciled',
    ]);
    expect(result.items.every((item) => item.actor?.id === f.context.actorUserId)).toBe(true);
    expect((await listUnifiedActivity(f.db, stranger.context)).items).toEqual([]);
  });

  it('joins lifecycle jobs and audit history, groups explicit operations and retains pending historical intent', async () => {
    const serverId = await f.server();
    const job = await enqueueServerOperation(f.db, f.context, serverId, {
      action: 'backup',
      idempotencyKey: randomUUID(),
    });
    const operationId = randomUUID();
    await audit(
      serverId,
      'server.files.requested',
      {
        operationId,
        action: 'copy',
        path: 'world/a',
        target: 'world/b',
        count: 2,
        password: 'PRIVATE_PASSWORD',
        content: 'PRIVATE_CONTENT',
      },
      new Date('2026-01-01T00:00:00Z'),
    );
    await audit(
      serverId,
      'server.files.completed',
      { operationId, action: 'copy', completed: 2, outcome: 'succeeded', output: 'PRIVATE_OUTPUT' },
      new Date('2026-01-01T00:00:01Z'),
    );
    await audit(serverId, 'server.files.requested', { action: 'delete', path: 'old.txt' });
    await audit(serverId, 'server.files.completed', { jobId: job.jobId, outcome: 'succeeded' });
    await audit(serverId, 'settings.secret.updated', { private: 'PRIVATE_SECRET' });
    const response = await listUnifiedActivity(f.db, f.context, { serverId });
    expect(response.items).toHaveLength(4);
    expect(response.items.find((row) => row.id === job.jobId)).toMatchObject({
      kind: 'job',
      jobId: job.jobId,
      action: 'backup',
      category: 'backups',
      state: 'queued',
      actor: { id: f.context.actorUserId, name: 'User' },
    });
    expect(response.items.find((row) => row.metadata.operationId === operationId)).toMatchObject({
      kind: 'audit',
      category: 'files',
      state: 'succeeded',
      metadata: {
        operationId,
        action: 'copy',
        path: 'world/a',
        target: 'world/b',
        count: 2,
        completed: 2,
      },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:01Z'),
    });
    expect(response.items.find((row) => row.metadata.action === 'delete')?.state).toBe('requested');
    expect(JSON.stringify(response)).not.toContain('PRIVATE_');
    expect(await getPlatformJob(f.db, f.context, job.jobId)).toMatchObject({
      id: job.jobId,
      state: 'queued',
      retry: { allowed: false },
    });
  });

  it('enforces current server/project scope and console manage permission without searchable private data', async () => {
    const peer = await managementFixture(f.db, { interactive: true });
    const project = await createProject(f.db, f.context, { name: 'Activity project' });
    const serverId = await f.server({ projectId: project.id });
    await audit(serverId, 'server.console.dispatched', {
      outcome: 'dispatched',
      command: 'say command-private-token',
      token: 'unsearchable-secret',
    });
    await audit(serverId, 'server.files.completed', {
      path: 'world/data',
      entries: [
        { path: 'world/data', target: 'copy/data', secret: 'unsearchable-secret', bytes: 10 },
      ],
      outcome: 'succeeded',
    });
    expect((await listUnifiedActivity(f.db, peer.context)).items).toEqual([]);
    await expect(listUnifiedActivity(f.db, peer.context, { serverId })).rejects.toThrow(
      'not_found',
    );
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'viewer',
    });
    const viewed = await listUnifiedActivity(f.db, peer.context, { serverId });
    expect(viewed.items.filter((row) => row.category !== 'access')).toHaveLength(3);
    expect(JSON.stringify(viewed)).not.toContain('command-private-token');
    expect(JSON.stringify(viewed)).not.toContain('unsearchable-secret');
    expect(
      (await listUnifiedActivity(f.db, peer.context, { serverId, q: 'command-private-token' }))
        .items,
    ).toEqual([]);
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId, q: 'unsearchable-secret' })).items,
    ).toEqual([]);
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'manager',
    });
    expect(
      (
        await listUnifiedActivity(f.db, peer.context, {
          serverId,
          category: 'console',
          q: 'command-private-token',
        })
      ).items[0]?.metadata.command,
    ).toBe('say command-private-token');
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: null,
    });
    expect((await listUnifiedActivity(f.db, peer.context)).items).toEqual([]);
  });

  it('filters normalized source/outcome/actor/time/action and distinguishes the real actor from support subject', async () => {
    const serverId = await f.server();
    const at = new Date('2026-03-01T12:30:00Z');
    await f.db
      .updateTable('user')
      .set({ username: `actor_${randomUUID().slice(0, 8)}`, name: 'Actual Owner' })
      .where('id', '=', f.owner.actorUserId)
      .execute();
    await audit(
      serverId,
      'server.sftp.file.rename',
      {
        source: 'sftp',
        outcome: 'failed',
        path: 'world.dat',
        target: 'new.dat',
        credentialUsername: 'technical-login',
      },
      at,
      { ...f.owner, subjectUserId: f.context.subjectUserId },
    );
    await audit(serverId, 'server.files.incomplete', {
      action: 'copy',
      outcome: 'partial_or_uncertain',
    });
    const response = await listUnifiedActivity(f.db, f.context, {
      serverId,
      category: 'files',
      source: 'sftp',
      state: 'failed',
      actorId: f.owner.actorUserId,
      from: '2026-03-01T12:29:00Z',
      to: '2026-03-01T12:31:00Z',
      q: 'Actual Owner',
      action: 'server.sftp.file.rename',
    });
    expect(response.items).toHaveLength(1);
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId, source: 'sftp', action: 'rename' }))
        .items,
    ).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      actorId: f.owner.actorUserId,
      subjectId: f.context.subjectUserId,
      actor: { name: 'Actual Owner', id: f.owner.actorUserId },
      source: 'sftp',
      outcome: 'failed',
      metadata: { credentialUsername: 'technical-login' },
    });
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId, action: 'copy', state: 'uncertain' }))
        .items,
    ).toHaveLength(1);
    const now = new Date();
    const support: AuthContext = {
      ...f.owner,
      subjectUserId: f.context.subjectUserId,
      sessionType: 'support',
      ownerElevation: true,
      support: {
        id: randomUUID(),
        reason: 'Review',
        startedAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
      },
    };
    const peer = await managementFixture(f.db);
    const foreign = await peer.server();
    await audit(foreign, 'server.files.completed', { outcome: 'succeeded' });
    expect(
      (await listUnifiedActivity(f.db, support)).items.every((row) => row.serverId !== foreign),
    ).toBe(true);
    await expect(listUnifiedActivity(f.db, support, { serverId: foreign })).rejects.toThrow(
      'not_found',
    );
  });

  it('paginates tied timestamps and mixed IDs without duplicates and keeps grouped identity stable on completion', async () => {
    const serverId = await f.server();
    const at = new Date('2026-02-02T02:02:02.123Z');
    const operationId = randomUUID();
    await audit(serverId, 'server.files.requested', { operationId, action: 'mkdir' }, at);
    for (let index = 0; index < 5; index++)
      await audit(serverId, 'server.files.completed', { path: `file-${index}` }, at);
    const job = await enqueueServerOperation(f.db, f.context, serverId, {
      action: 'start',
      idempotencyKey: randomUUID(),
    });
    await f.db
      .updateTable('operation_jobs')
      .set({ created_at: at })
      .where('id', '=', job.jobId)
      .execute();
    const initial = await listUnifiedActivity(f.db, f.context, { serverId });
    await audit(
      serverId,
      'server.files.completed',
      { operationId, outcome: 'succeeded' },
      new Date(at.getTime() + 1),
    );
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await listUnifiedActivity(f.db, f.context, {
        serverId,
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...result.items.map((row) => row.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(initial.items.map((row) => row.id));
    expect(new Set(ids).size).toBe(8);
    expect(ids).toContain(
      initial.items.find((row) => row.metadata.operationId === operationId)?.id,
    );
    await expect(listUnifiedActivity(f.db, f.context, { cursor: 'invalid' })).rejects.toThrow(
      'validation_failed',
    );
  });

  it('groups batch events, keeps distinct actors separate and never invents credential success', async () => {
    const serverId = await f.server();
    const operationId = randomUUID();
    const at = new Date('2026-04-01T00:00:00Z');
    await audit(
      serverId,
      'server.upload.batch_prepared',
      { operationId, action: 'upload', outcome: 'requested', count: 2 },
      at,
    );
    const before = await listUnifiedActivity(f.db, f.context, { serverId, category: 'files' });
    await audit(
      serverId,
      'server.upload.batch_closed',
      {
        operationId,
        action: 'upload',
        outcome: 'partial',
        count: 2,
        completed: 1,
        cancelled: 1,
        entries: [
          { id: 'one', path: 'one.dat', state: 'complete', bytes: 5 },
          { id: 'two', path: 'two.dat', state: 'cancelled' },
        ],
      },
      at,
    );
    await audit(serverId, 'server.upload.cancelled', { claimId: randomUUID() }, at);
    await audit(
      serverId,
      'server.upload.batch_closed',
      { operationId, action: 'upload', outcome: 'cancelled' },
      at,
      f.owner,
    );
    const after = await listUnifiedActivity(f.db, f.context, { serverId, category: 'files' });
    expect(after.items).toHaveLength(2);
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId, q: 'two.dat' })).items,
    ).toHaveLength(1);
    expect(after.items.find((row) => row.actorId === f.context.actorUserId)).toMatchObject({
      id: before.items[0]?.id,
      outcome: 'partial',
      metadata: {
        count: 2,
        completed: 1,
        cancelled: 1,
        entries: [
          { id: 'one', path: 'one.dat', state: 'complete', bytes: 5 },
          { id: 'two', path: 'two.dat', state: 'cancelled' },
        ],
      },
    });
    for (const action of ['issued', 'rotated', 'revoked', 'access_revoked'])
      await audit(serverId, `server.sftp.${action}`);
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId, category: 'access' })).items.map(
        (row) => row.state,
      ),
    ).toEqual(['requested', 'requested', 'requested', 'requested']);
  });

  it('never presents the queued preparation manifest as current after compact upload snapshots', async () => {
    const serverId = await f.server();
    const at = new Date('2026-04-02T00:00:00Z');
    for (const [outcome, entryState] of [
      ['succeeded', 'complete'],
      ['uncertain', 'uncertain'],
      ['requested', 'active'],
    ] as const) {
      const operationId = randomUUID();
      await audit(
        serverId,
        'server.upload.batch_prepared',
        {
          operationId,
          outcome: 'requested',
          count: 2,
          entries: [
            { id: 'one', path: 'one.dat', state: 'queued' },
            { id: 'two', path: 'two.dat', state: 'queued' },
          ],
        },
        at,
      );
      await audit(
        serverId,
        'server.upload.confirmed',
        {
          operationId,
          outcome,
          completed: outcome === 'succeeded' ? 2 : 0,
          entry: { id: 'two', path: 'two.dat', state: entryState },
        },
        new Date(at.getTime() + 1),
      );
      const row = (
        await listUnifiedActivity(f.db, f.context, { serverId, category: 'files' })
      ).items.find((item) => item.metadata.operationId === operationId);
      expect(row?.metadata).toMatchObject({
        count: 2,
        entry: {
          id: 'two',
          path: 'two.dat',
          state: entryState === 'active' ? 'running' : entryState,
        },
      });
      expect(row?.metadata.entries).toBeUndefined();
      expect(row?.outcome).toBe(outcome);
      await audit(
        serverId,
        'server.upload.batch_closed',
        {
          operationId,
          outcome: 'succeeded',
          entry: { id: 'two', path: 'two.dat', state: 'complete' },
          entries: [
            { id: 'one', path: 'one.dat', state: 'complete' },
            { id: 'two', path: 'two.dat', state: 'complete' },
          ],
        },
        new Date(at.getTime() + 2),
      );
      const full = (
        await listUnifiedActivity(f.db, f.context, { serverId, category: 'files' })
      ).items.find((item) => item.metadata.operationId === operationId);
      expect(full?.metadata.entries).toEqual([
        { id: 'one', path: 'one.dat', state: 'complete' },
        { id: 'two', path: 'two.dat', state: 'complete' },
      ]);
    }
  });

  it('anchors membership history to the affected servers, including role removal and later reassignment', async () => {
    const peer = await managementFixture(f.db, { interactive: true });
    const first = await createProject(f.db, f.context, { name: 'First' });
    const next = await createProject(f.db, f.context, { name: 'Next' });
    const serverId = await f.server({ projectId: first.id });
    const unrelated = await f.server({ projectId: next.id });
    await setProjectMember(f.db, f.context, first.id, {
      userId: peer.context.subjectUserId,
      role: 'viewer',
    });
    const joined = await listUnifiedActivity(f.db, peer.context, { serverId, category: 'access' });
    expect(joined.items).toHaveLength(1);
    expect(joined.items[0]).toMatchObject({
      action: 'server.member.updated',
      outcome: 'succeeded',
      metadata: { role: 'viewer', memberName: 'User' },
    });
    expect(joined.items[0]?.metadata.memberUsername).toEqual(expect.any(String));
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId: unrelated, category: 'access' }))
        .items,
    ).toEqual([]);
    await setProjectMember(f.db, f.context, first.id, {
      userId: peer.context.subjectUserId,
      role: null,
    });
    await expect(listUnifiedActivity(f.db, peer.context, { serverId })).rejects.toThrow(
      'not_found',
    );
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId, category: 'access' })).items[0]
        ?.metadata.role,
    ).toBe('removed');
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: next.id })
      .where('id', '=', serverId)
      .execute();
    await setProjectMember(f.db, f.context, first.id, {
      userId: peer.context.subjectUserId,
      role: 'operator',
    });
    expect(
      (await listUnifiedActivity(f.db, f.context, { serverId, category: 'access' })).items,
    ).toHaveLength(2);
    await setProjectMember(f.db, f.context, next.id, {
      userId: peer.context.subjectUserId,
      role: 'viewer',
    });
    const moved = await listUnifiedActivity(f.db, peer.context, { serverId, category: 'access' });
    expect(moved.items).toHaveLength(3);
    expect(moved.items.some((row) => row.id === joined.items[0]?.id)).toBe(true);
  });

  it('bounds snapshot hydration on a page with thousands of large historical snapshots', async () => {
    const serverId = await f.server();
    await sql`insert into audit_events (id,actor_user_id,subject_user_id,action,correlation_id,metadata,created_at)
      select gen_random_uuid(), ${f.context.actorUserId}, ${f.context.subjectUserId},
        'server.upload.confirmed', 'activity-performance-fixture', jsonb_build_object(
          'serverId', ${serverId}::text, 'operationId', md5(group_number::text)::uuid::text,
          'outcome', case when snapshot = 32 then 'succeeded' else 'requested' end,
          'entries', (select jsonb_agg(jsonb_build_object('path', 'world/' || md5((group_number * 10000 + snapshot * 100 + entry)::text) || repeat('/directory', 8), 'state','complete','bytes',1000)) from generate_series(1,100) entry)
        ), '2026-01-01'::timestamptz + group_number * interval '1 minute' + snapshot * interval '1 second'
      from generate_series(1,96) group_number cross join generate_series(1,32) snapshot`.execute(
      f.db,
    );
    await sql`analyze audit_events`.execute(f.db);
    let captured: { sql: string; parameters: readonly unknown[] } | undefined;
    const traced = f.db.withPlugin({
      transformQuery(args) {
        const compiled = f.db.getExecutor().compileQuery(args.node, args.queryId);
        if (compiled.sql.includes('audit_candidates as materialized')) captured = compiled;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const result = await listUnifiedActivity(traced, f.context, { serverId, limit: 5 });
    expect(result.items).toHaveLength(5);
    expect(captured).toBeDefined();
    const explained = await database.pool.query(
      `explain (analyze, buffers, format json) ${captured?.sql}`,
      [...(captured?.parameters ?? [])],
    );
    type Node = {
      'Node Type': string;
      'Index Name'?: string;
      'Subplan Name'?: string;
      'Actual Rows': number;
      'Actual Loops': number;
      Plans?: Node[];
    };
    const plan = explained.rows[0]['QUERY PLAN'][0] as { Plan: Node; 'Execution Time': number };
    const flatten = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
    const nodes = flatten(plan.Plan);
    const candidates = nodes.find((node) => node['Subplan Name'] === 'CTE audit_candidates');
    expect(candidates?.['Actual Rows']).toBe(6);
    expect(nodes.some((node) => node['Node Type'] === 'WindowAgg')).toBe(false);
    const lookups = nodes.filter(
      (node) => node['Index Name'] === 'audit_events_activity_group_history',
    );
    const snapshotRows = lookups.reduce(
      (sum, node) => sum + node['Actual Rows'] * node['Actual Loops'],
      0,
    );
    expect(lookups).toHaveLength(2);
    expect(snapshotRows).toBe(12);
    process.stdout.write(
      `Activity EXPLAIN fixture: 3,072 large snapshots, 96 groups, 6 page candidates, ${snapshotRows} first/latest index rows, ${plan['Execution Time']} ms.\n`,
    );
    expect(
      (
        await listUnifiedActivity(f.db, f.context, {
          serverId,
          state: 'requested',
          category: 'files',
        })
      ).items,
    ).toEqual([]);
    const ranged = await listUnifiedActivity(f.db, f.context, {
      serverId,
      from: '2026-01-01T01:30:00Z',
      to: '2026-01-01T01:35:10Z',
      limit: 20,
    });
    expect(ranged.items).toHaveLength(6);
    expect(ranged.items.every((row) => row.outcome === 'succeeded')).toBe(true);
  });

  it('identifies schedule and gateway work independently of the persisted human actor', async () => {
    const serverId = await f.server();
    const job = await enqueueServerOperation(f.db, f.context, serverId, {
      action: 'backup',
      idempotencyKey: randomUUID(),
    });
    await f.db
      .updateTable('server_operations')
      .set({ plan: JSON.stringify({ scheduleAutomation: { scheduleId: randomUUID() } }) })
      .where('job_id', '=', job.jobId)
      .execute();
    expect((await listUnifiedActivity(f.db, f.context, { serverId })).items[0]).toMatchObject({
      source: 'schedule',
      actorId: f.context.actorUserId,
    });
    await f.db
      .updateTable('server_operations')
      .set({ plan: JSON.stringify({ gatewayAutomation: { kind: 'sleep' } }) })
      .where('job_id', '=', job.jobId)
      .execute();
    expect((await listUnifiedActivity(f.db, f.context, { serverId })).items[0]?.source).toBe(
      'system',
    );
  });
});
