// Explicit one-server provider-owner handoff. No power/file/server creation operations.
// Run only with operation-specific Owner approval; never prints credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(`${process.cwd()}/${path}`).href);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseArguments(args) {
  const names = [
    '--server',
    '--expected-provider-id',
    '--expected-provider-uuid',
    '--expected-owner-id',
  ];
  const values = {};
  let approved = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--owner-approved' && !approved) {
      approved = true;
      continue;
    }
    if (!names.includes(flag) || values[flag] !== undefined || !args[index + 1])
      throw new Error('Invalid handoff arguments');
    values[flag] = args[++index];
  }
  if (
    !approved ||
    !uuid.test(values['--server'] ?? '') ||
    !uuid.test(values['--expected-provider-uuid'] ?? '')
  )
    throw new Error('Explicit approval and exact server identities required');
  for (const name of ['--expected-provider-id', '--expected-owner-id']) {
    if (!/^[1-9][0-9]*$/.test(values[name] ?? '') || !Number.isSafeInteger(Number(values[name])))
      throw new Error('Positive provider identity required');
  }
  return {
    serverId: values['--server'].toLowerCase(),
    providerId: Number(values['--expected-provider-id']),
    providerUuid: values['--expected-provider-uuid'].toLowerCase(),
    oldOwnerId: Number(values['--expected-owner-id']),
  };
}
export function assertRemote(remote, server, expected) {
  assert.equal(remote.id, expected.providerId);
  assert.equal(remote.uuid, expected.providerUuid);
  assert.equal(remote.identifier, server.pterodactyl_identifier);
  assert.equal(remote.external_id, server.external_id);
  assert.equal(remote.node, server.pterodactyl_node_id);
}

/** Only for an explicitly approved handoff after exact live owner readback.
 * Equal revision is legitimate when relink committed but local confirmation was lost:
 * newer outbox delivery can retain the local invalidation latch at that same revision.
 * Ordinary feed processing must never use this administrative repair rule.
 */
export function assertHandoffRevision(snapshot, projection) {
  if (
    snapshot.type !== 'snapshot' ||
    (projection && BigInt(snapshot.revision) < BigInt(projection.revision))
  )
    throw new Error('Current authenticated snapshot required for explicit handoff repair');
}

export async function main(args = process.argv.slice(2)) {
  const expected = parseArguments(args);
  const { containerEnvironment } = await load('deploy/container-env.mjs');
  const { createDatabase, getSettings, getSecret } = await load('packages/database/src/index.ts');
  const { SecretCodec, encryptionKeyFromBase64 } = await load('packages/core/src/index.ts');
  const { createPterodactylAdapter, createNickHostingBridge, providerChangeSchema } = await load(
    'packages/pterodactyl-adapter/src/index.ts',
  );
  const { lockResources } = await load('packages/server-management/src/admission.ts');
  const requireDatabase = createRequire(`${process.cwd()}/packages/database/package.json`);
  const { sql } = await import(pathToFileURL(requireDatabase.resolve('kysely')).href);
  const env = containerEnvironment(process.env);
  const { db, pool } = createDatabase(env.DATABASE_URL);
  try {
    const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
    const codec = new SecretCodec({
      activeKeyId: keyId,
      keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
    });
    const [{ values }, applicationKey] = await Promise.all([
      getSettings(db, env),
      getSecret(db, codec, 'pterodactylApplicationKey', env),
    ]);
    if (!applicationKey || !values.pterodactylBaseUrl)
      throw new Error('Provider configuration required');
    const providerUrl = values.pterodactylBaseUrl.replace(/\/$/, '');
    const options = { baseURL: providerUrl, applicationKey };
    const adapter = createPterodactylAdapter(options);
    const bridge = createNickHostingBridge(options);
    async function lockedState(tx) {
      await lockResources(tx);
      const server = await tx
        .selectFrom('managed_servers as s')
        .innerJoin('managed_nodes as n', 'n.id', 's.node_id')
        .selectAll('s')
        .select('n.pterodactyl_node_id')
        .where('s.id', '=', expected.serverId)
        .where('s.deleted_at', 'is', null)
        .forUpdate('s')
        .executeTakeFirstOrThrow();
      assert.equal(server.pterodactyl_id, expected.providerId);
      assert.equal(server.pterodactyl_uuid, expected.providerUuid);
      if (server.active_operation_id) throw new Error('Server has an active operation');
      const operation = await tx
        .selectFrom('server_operations as o')
        .innerJoin('operation_jobs as j', 'j.id', 'o.job_id')
        .select('o.job_id')
        .where('o.server_id', '=', server.id)
        .where((eb) =>
          eb.or([
            eb('j.state', 'in', ['queued', 'running']),
            eb('o.effect_state', 'in', ['prepared', 'uncertain']),
            eb('o.lease_until', '>', new Date()),
          ]),
        )
        .executeTakeFirst();
      const job = await tx
        .selectFrom('operation_jobs')
        .select('id')
        .where('state', 'in', ['queued', 'running'])
        .where(sql`command->'payload'->>'serverId'`, '=', server.id)
        .executeTakeFirst();
      if (operation || job)
        throw new Error('Pending or uncertain server work requires resolution before handoff');
      const account = await tx
        .selectFrom('provider_accounts')
        .selectAll()
        .where('user_id', '=', server.owner_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        account.status !== 'ready' ||
        account.provider_url !== providerUrl ||
        !account.instance_id ||
        !account.provider_id ||
        !account.provider_uuid ||
        !account.key_envelope ||
        !account.key_identifier
      )
        throw new Error('Technical account is not ready');
      assert.equal(account.external_id, `nh:${account.instance_id}:${server.owner_id}`);
      if (![expected.oldOwnerId, account.provider_id].includes(server.provider_user_id))
        throw new Error('Local owner differs from approved handoff');
      const feed = await tx
        .selectFrom('provider_change_feeds')
        .selectAll()
        .where('instance_id', '=', account.instance_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!feed.enabled || feed.provider_url !== providerUrl)
        throw new Error('Provider feed identity mismatch');
      const projection = await tx
        .selectFrom('provider_server_projections')
        .selectAll()
        .where('server_id', '=', server.id)
        .forUpdate()
        .executeTakeFirst();
      if (projection && projection.instance_id !== account.instance_id)
        throw new Error('Projection instance mismatch');
      return { server, account, projection };
    }
    // Commit the intended exact identity and prior projection before a remote mutation.
    const plan = await db.transaction().execute(async (tx) => {
      const { server, account, projection } = await lockedState(tx);
      const previous = await tx
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', 'provider.account_handoff.planned')
        .where(sql`metadata->>'serverId'`, '=', server.id)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      const identity = {
        serverId: server.id,
        providerId: expected.providerId,
        providerUuid: expected.providerUuid,
        oldOwnerId: expected.oldOwnerId,
        targetOwnerId: account.provider_id,
        instanceId: account.instance_id,
        providerUrl,
      };
      if (previous) {
        for (const [name, value] of Object.entries(identity))
          assert.equal(previous.metadata[name], value);
        return { id: previous.id, ...identity };
      }
      const id = randomUUID();
      await tx
        .insertInto('audit_events')
        .values({
          id,
          actor_user_id: null,
          subject_user_id: server.owner_id,
          action: 'provider.account_handoff.planned',
          correlation_id: id,
          metadata: {
            ...identity,
            authorization: 'explicit-owner-cli',
            previousProjection: projection ?? null,
          },
        })
        .execute();
      return { id, ...identity };
    });
    await db.transaction().execute(async (tx) => {
      const { server, account, projection } = await lockedState(tx);
      assert.equal(account.provider_id, plan.targetOwnerId);
      assert.equal(account.instance_id, plan.instanceId);
      const providerUser = (await adapter.listUsers()).find(
        (user) => user.id === account.provider_id,
      );
      if (
        !providerUser ||
        providerUser.root_admin ||
        providerUser.uuid !== account.provider_uuid ||
        providerUser.external_id !== account.external_id
      )
        throw new Error('Technical provider account identity mismatch');
      let remote = await adapter.getApplicationServer(expected.providerId);
      assertRemote(remote, server, expected);
      if (![expected.oldOwnerId, account.provider_id].includes(remote.user))
        throw new Error('Remote owner differs from approved handoff');
      if (remote.user !== account.provider_id) {
        const details = {
          name: remote.name,
          user: account.provider_id,
          external_id: remote.external_id,
          ...(remote.description !== null ? { description: remote.description } : {}),
        };
        try {
          await adapter.updateDetails(expected.providerId, details);
        } catch {
          /* The request may have committed. Read exact state; never replay blindly. */
        }
        remote = await adapter.getApplicationServer(expected.providerId);
        assertRemote(remote, server, expected);
        if (remote.user !== account.provider_id)
          throw new Error('Provider handoff not confirmed; rerun only after reviewing the plan');
        assert.equal(remote.name, details.name);
        assert.equal(remote.description, details.description ?? null);
      }
      const identity = {
        providerId: remote.id,
        providerUuid: remote.uuid,
        identifier: remote.identifier,
        externalId: remote.external_id,
        nodeId: remote.node,
      };
      const snapshot = providerChangeSchema.parse(
        await bridge.linkServer(account.instance_id, identity, account.provider_id),
      );
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.instanceId, account.instance_id);
      assert.deepEqual(snapshot.server, identity);
      const age = Date.now() - new Date(snapshot.occurredAt).getTime();
      if (age < 0 || age > 120_000) throw new Error('Fresh provider snapshot required');
      if (projection) {
        assert.deepEqual(providerChangeSchema.parse(projection.payload).server, identity);
        assertHandoffRevision(snapshot, projection);
      }
      // A second live read must still confirm the exact provider owner before the local pin changes.
      const confirmed = await adapter.getApplicationServer(expected.providerId);
      assertRemote(confirmed, server, expected);
      assert.equal(confirmed.user, account.provider_id);
      await tx
        .updateTable('managed_servers')
        .set({ provider_user_id: account.provider_id, updated_at: new Date() })
        .where('id', '=', server.id)
        .execute();
      await tx
        .insertInto('provider_server_projections')
        .values({
          server_id: server.id,
          instance_id: account.instance_id,
          revision: String(snapshot.revision),
          payload: snapshot,
          synchronized_at: new Date(snapshot.occurredAt),
          valid: true,
          identity_invalidated: false,
        })
        .onConflict((c) =>
          c.column('server_id').doUpdateSet({
            revision: String(snapshot.revision),
            payload: snapshot,
            synchronized_at: new Date(snapshot.occurredAt),
            valid: true,
            identity_invalidated: false,
          }),
        )
        .execute();
      await tx
        .updateTable('provider_change_feeds')
        .set({ healthy_at: null, generation: sql`generation + 1` })
        .where('instance_id', '=', account.instance_id)
        .execute();
      await tx
        .insertInto('audit_events')
        .values({
          id: randomUUID(),
          actor_user_id: null,
          subject_user_id: server.owner_id,
          action: 'provider.account_handoff.confirmed',
          correlation_id: plan.id,
          metadata: {
            serverId: server.id,
            providerId: remote.id,
            providerUuid: remote.uuid,
            oldOwnerId: expected.oldOwnerId,
            targetOwnerId: account.provider_id,
            snapshotRevision: snapshot.revision,
            previousProjection: projection ?? null,
          },
        })
        .execute();
    });
    console.log(
      JSON.stringify({
        confirmed: true,
        serverId: expected.serverId,
        providerId: expected.providerId,
        providerUuid: expected.providerUuid,
        oldOwnerId: expected.oldOwnerId,
        targetOwnerId: plan.targetOwnerId,
        auditId: plan.id,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        confirmed: false,
        error: error instanceof Error ? error.name : 'Error',
        reason: error?.reason,
        status: error?.upstreamStatus,
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
