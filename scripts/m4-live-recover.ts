/** Exact opt-in cleanup of a failed M2-only Minecraft bootstrap. This is not a
 * product recovery API and never manufactures successful Core job completion. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { type AuthContext, authSessionId } from '../packages/core/src/index.js';
import { createDatabase, recordAudit } from '../packages/database/src/index.js';
import {
  createContainerObserver,
  createNetworkObserver,
  createPterodactylAdapter,
} from '../packages/pterodactyl-adapter/src/index.js';
import {
  backendAllocationPoolSchema,
  verifyManagedIdentity,
} from '../packages/server-management/src/index.js';
import {
  guardMinecraftLiveAdapter,
  type MinecraftLiveLedger,
  proveMinecraftLiveAsset,
  readMinecraftLivePlan,
  saveMinecraftLiveLedger,
} from './m4-live.js';

async function main() {
  const args = process.argv.slice(2),
    option = (name: string) => args[args.indexOf(name) + 1];
  assert(args.includes('--owner-approved-failed-bootstrap-cleanup'));
  const forced = args.includes('--force-stopped-fixture-cleanup');
  for (const required of ['--plan', '--ledger', '--stopped-runner-pid'])
    assert(args.includes(required));
  const runnerPid = Number(option('--stopped-runner-pid'));
  assert(Number.isSafeInteger(runnerPid) && runnerPid > 1 && runnerPid !== process.pid);
  const quiesced = () => {
    try {
      process.kill(runnerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    throw new Error('The recorded runner is still alive; stop before recovery');
  };
  quiesced();
  const { plan, planSha256 } = await readMinecraftLivePlan(option('--plan') ?? '');
  assert(
    plan.approval.endpoints &&
      plan.approval.eula &&
      plan.approval.reference &&
      plan.approval.externalExposureAcknowledged,
  );
  const path = resolve(option('--ledger') ?? '');
  assert.equal(dirname(path), resolve('mountdata/test-assets'));
  assert.match(basename(path), /^m4-live-[a-f0-9-]{36}\.json$/);
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0);
  const ledger = JSON.parse(await readFile(path, 'utf8')) as MinecraftLiveLedger & {
    scenario: {
      schema: string;
      ownerId: string;
      sessionId: string;
      activePhase?: string;
      failedAt?: string;
      recoveredAt?: string;
    };
  };
  assert.equal(ledger.planSha256, planSha256);
  assert.equal(ledger.branch, 'milestone/m4-minecraft');
  assert(ledger.scenario.activePhase?.startsWith('bootstrap:'));
  assert.match(ledger.scenario.schema, /^nh_test_[a-f0-9]{32}$/);
  const assets = ledger.assets.filter((asset) => !asset.deletedAt);
  assert.equal(assets.length, 1, 'Exactly one complete bootstrap asset is required');
  const asset = assets[0];
  assert(asset?.id && asset.uuid && asset.identifier && asset.attemptedAt && asset.createdAt);
  const secret = parseEnv(await readFile(plan.credentialsFile, 'utf8'));
  assert(
    secret.NH_PTERODACTYL_BASE_URL &&
      secret.NH_PTERODACTYL_APPLICATION_KEY &&
      secret.NH_PTERODACTYL_CLIENT_KEY,
  );
  assert.equal(
    ledger.apiOriginSha256,
    createHash('sha256').update(new URL(secret.NH_PTERODACTYL_BASE_URL).origin).digest('hex'),
  );
  const observer = createContainerObserver(plan.observer.dockerSocket);
  const shared = {
    baseURL: secret.NH_PTERODACTYL_BASE_URL,
    applicationKey: secret.NH_PTERODACTYL_APPLICATION_KEY,
    clientKey: secret.NH_PTERODACTYL_CLIENT_KEY,
    containerObserver: observer,
  };
  const node = await createPterodactylAdapter(shared).getNode(plan.nodeId);
  assert.equal(node.uuid, plan.nodeUuid);
  const origin = new URL(`${node.scheme}://${node.fqdn}:${node.daemon_listen}`).origin;
  const raw = createPterodactylAdapter({
    ...shared,
    webSocketOrigins: [origin.replace(/^http/, 'ws')],
  });
  const adapter = guardMinecraftLiveAdapter(raw, plan, ledger, path);
  const databaseUrl = process.env.NH_TEST_DATABASE_URL;
  assert(databaseUrl);
  const url = new URL(databaseUrl);
  assert(
    ['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_DATABASE_HOST].includes(
      url.hostname,
    ),
  );
  assert.equal(url.pathname, '/nickhosting_test');
  assert.equal(url.username, 'nickhosting_test');
  const { db, pool } = createDatabase(databaseUrl, {
    options: `-c search_path=${ledger.scenario.schema}`,
    max: 2,
  });
  const lock = await pool.connect();
  let acquired = false;
  const key = `:nickhosting:server:${asset.managedServerId}`;
  const save = async (event: string, details: Record<string, unknown> = {}) => {
    ledger.events.push({
      at: new Date().toISOString(),
      event,
      assetId: asset.managedServerId,
      details,
    });
    await saveMinecraftLiveLedger(path, ledger);
  };
  try {
    const schema = await lock.query('select current_schema() as name');
    assert.equal(schema.rows[0]?.name, ledger.scenario.schema);
    acquired =
      (
        await lock.query(
          'select pg_try_advisory_lock(hashtextextended(current_schema() || $1,0)) as acquired',
          [key],
        )
      ).rows[0]?.acquired === true;
    assert(acquired, 'Core processor is active; recovery cannot overlap it');
    quiesced();
    const server = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', asset.managedServerId)
      .executeTakeFirstOrThrow();
    const mapping = await db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow();
    assert.equal(mapping.game_id, 'm4-bootstrap');
    assert.equal(server.owner_id, ledger.scenario.ownerId);
    assert(server.active_operation_id && !server.deleted_at);
    const operation = await db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', server.active_operation_id)
      .where('server_id', '=', server.id)
      .executeTakeFirstOrThrow();
    assert.equal(operation.action, 'start');
    const job = await db
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', operation.job_id)
      .executeTakeFirstOrThrow();
    assert(job.state !== 'succeeded');
    assert.equal(job.actor_id, ledger.scenario.ownerId);
    assert.equal(job.resource_owner_id, server.owner_id);
    const original = {
      jobId: job.id,
      state: job.state,
      phase: operation.phase,
      effectState: operation.effect_state,
      activeOperationId: server.active_operation_id,
    };
    assert.equal(
      (
        await db
          .selectFrom('gateway_routes')
          .select('id')
          .where('server_id', '=', server.id)
          .execute()
      ).length,
      0,
    );
    assert.equal(
      (
        await db
          .selectFrom('server_operations as operation')
          .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
          .select('job.id')
          .where('operation.server_id', '=', server.id)
          .where('job.id', '!=', job.id)
          .where('job.state', 'not in', ['succeeded', 'failed'])
          .execute()
      ).length,
      0,
    );
    const reservations = await db
      .selectFrom('resource_reservations')
      .selectAll()
      .where('server_id', '=', server.id)
      .execute();
    const installationReservations = await db
      .selectFrom('installation_reservations')
      .selectAll()
      .where('server_id', '=', server.id)
      .execute();
    const networkObserver = createNetworkObserver(plan.observer);
    await networkObserver.observe(); // Exact configured daemon and host namespace must still match.
    const context: AuthContext = {
      actorUserId: ledger.scenario.ownerId,
      subjectUserId: ledger.scenario.ownerId,
      role: 'owner',
      sessionType: 'regular',
      ownerElevation: false,
      [authSessionId]: ledger.scenario.sessionId,
    };
    const owner = await db
      .selectFrom('user')
      .select('role')
      .where('id', '=', context.actorUserId)
      .executeTakeFirstOrThrow();
    assert.equal(owner.role, 'owner');
    const prove = async () => {
      quiesced();
      const remote = await proveMinecraftLiveAsset(raw, plan, ledger, asset);
      await verifyManagedIdentity(db, server, remote);
    };
    await prove();
    await observer.preflight();
    ledger.scenario.failedAt ??= new Date().toISOString();
    await save('bootstrap.recovery.explicitly-authorized', {
      original,
      retainedEvidence: { job, operation, reservations, installationReservations, server },
      stoppedRunnerPid: runnerPid,
      reason:
        'Test-only bootstrap startup semicolon captured server stdout; stop and delete only proven fixture',
      productRecoveryVerified: false,
      forcedStopRequested: forced,
    });
    await recordAudit(db, context, 'minecraft.test-bootstrap.cleanup.requested', {
      serverId: server.id,
      jobId: job.id,
      runId: ledger.runId,
      stoppedRunnerPid: runnerPid,
    });
    if (forced) {
      assert(
        ledger.events.some(
          (event) =>
            event.assetId === asset.managedServerId &&
            event.event === 'mutation.stopWithConfirmation.returned',
        ),
        'Forced cleanup is limited to the already attempted bootstrap stop',
      );
      await prove();
      await save('bootstrap.recovery.force-stop-intent', {
        original,
        gracefulStopVerified: false,
        milestoneAcceptanceVerified: false,
        reason: 'Explicit scoped cleanup after the failed fixture stop; test data may be lost',
      });
      await adapter.power(asset.identifier, 'kill');
      const deadline = Date.now() + 90000;
      let terminal = false;
      do {
        await prove();
        terminal =
          (await observer.stopped(asset.uuid, 'server')) &&
          (await observer.stopped(asset.uuid, 'installer')) &&
          (await adapter.getResources(asset.identifier)).current_state === 'offline';
        if (!terminal) await delay(1500);
      } while (!terminal && Date.now() < deadline);
      assert(terminal, 'Forced stop lacks exact physical/API terminal proof; do not delete');
      await save('bootstrap.recovery.force-stopped', {
        original,
        gracefulStopVerified: false,
        milestoneAcceptanceVerified: false,
      });
    } else {
      let confirmed = false;
      const result = await adapter.stopWithConfirmation(asset.id, asset.identifier, {
        authorize: async () => {
          await prove();
          return true;
        },
        beforePower: prove,
        onConfirmed: async () => {
          await prove();
          assert(await observer.stopped(asset.uuid ?? '', 'server'));
          assert(await observer.stopped(asset.uuid ?? '', 'installer'));
          await save('bootstrap.recovery.stop-confirmed', { original });
          confirmed = true;
        },
      });
      if (!result.confirmed || !confirmed) {
        await save('bootstrap.recovery.stop-unconfirmed', { original, deletionAttempted: false });
        throw new Error('Missing terminal stop proof; retain everything');
      }
    }
    await prove();
    assert(await observer.stopped(asset.uuid, 'server'));
    assert(await observer.stopped(asset.uuid, 'installer'));
    await adapter.deleteServer(asset.id);
    assert.equal(await raw.findServerByExternalId(asset.externalId), null);
    assert(
      !(await raw.listApplicationServers()).some(
        (entry) => entry.id === asset.id || entry.uuid === asset.uuid,
      ),
    );
    const pin = backendAllocationPoolSchema.parse(plan.backendAllocationPool).allocations[0];
    assert(pin);
    const allocation = (await raw.listAllocations(plan.nodeId)).find(
      (entry) => entry.id === pin.allocationId,
    );
    assert(
      allocation &&
        allocation.ip === pin.address &&
        allocation.port === pin.port &&
        !allocation.assigned,
    );
    const goneDeadline = Date.now() + 20000;
    let containersGone = false;
    do {
      const observed = await networkObserver.observe();
      containersGone = !observed.containers.some((container) =>
        [`/${asset.uuid}`, `/${asset.uuid}_installer`].includes(container.name),
      );
      if (!containersGone) await delay(1000);
    } while (!containersGone && Date.now() < goneDeadline);
    assert(
      containersGone,
      'Remote API deletion did not prove container cleanup; preserve failed run',
    );
    const finalJob = await db
      .selectFrom('operation_jobs')
      .select(['state'])
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    const finalServer = await db
      .selectFrom('managed_servers')
      .select(['active_operation_id'])
      .where('id', '=', server.id)
      .executeTakeFirstOrThrow();
    assert.equal(finalJob.state, original.state);
    assert.equal(finalServer.active_operation_id, original.activeOperationId);
    ledger.scenario.recoveredAt = new Date().toISOString();
    await save('bootstrap.recovery.remote-cleanup-confirmed', {
      original,
      schemaRetained: true,
      originalCoreJobRetainedUnresolved: true,
      allocationFreed: true,
      containersGone: true,
      productRecoveryVerified: false,
      forcedStop: forced,
      gracefulStopVerified: !forced,
    });
    await recordAudit(db, context, 'minecraft.test-bootstrap.cleanup.confirmed', {
      serverId: server.id,
      jobId: job.id,
      runId: ledger.runId,
      outcome: forced
        ? 'forced-test-cleanup-original-job-unresolved'
        : 'remote-asset-deleted-original-job-unresolved',
    });
    console.log(
      JSON.stringify({
        recovery: forced ? 'forced-test-cleanup-confirmed' : 'confirmed',
        uuid: asset.uuid,
        originalJob: original.state,
        schemaRetained: true,
      }),
    );
  } finally {
    if (acquired)
      await lock.query('select pg_advisory_unlock(hashtextextended(current_schema() || $1,0))', [
        key,
      ]);
    lock.release();
    await db.destroy();
  }
}
main().catch(() => {
  console.error(
    'Scoped bootstrap recovery stopped. Preserve the protected ledger/schema and request review.',
  );
  process.exitCode = 1;
});
