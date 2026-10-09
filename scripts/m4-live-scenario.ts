/** Opt-in, sequential real-server validation. Read docs/M4-LIVE-TESTS.md first.
 * Preparation/import alone has no effects. Never silently cleans up a failed run. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import minecraftProtocol, { type Client } from 'minecraft-protocol';
import { createApp } from '../apps/api/src/app.js';
import { createGatewayRuntime } from '../apps/game-gateway/src/main.js';
import {
  type MinecraftEvidence,
  minecraftDigest,
  minecraftEvidenceSchema,
  minecraftVerificationChecks,
} from '../games/minecraft/src/compatibility.js';
import { createMinecraftGatewayModuleAdapter } from '../games/minecraft/src/gateway-module.js';
import { minecraftManifest } from '../games/minecraft/src/manifest.js';
import { probeMinecraftStatus } from '../games/minecraft/src/protocol.js';
import {
  type MinecraftRuntimeMapping,
  validateMinecraftRuntimeMapping,
} from '../games/minecraft/src/runtime.js';
import { inspectMinecraftLevelDat } from '../games/minecraft/src/world.js';
import { defaultGatewayDataPolicy } from '../packages/core/src/gateway-config.js';
import {
  type AuthContext,
  authSessionId,
  DomainError,
  SecretCodec,
} from '../packages/core/src/index.js';
import { createDatabase, migrate } from '../packages/database/src/index.js';
import {
  type GatewayRoute,
  type GatewaySnapshot,
  gameManifestSchema,
} from '../packages/game-sdk/src/index.js';
import {
  backupSchema,
  createContainerObserver,
  createPterodactylAdapter,
  type PterodactylAdapter,
  PterodactylError,
} from '../packages/pterodactyl-adapter/src/index.js';
import {
  backendAllocationPoolSchema,
  createManagedServer,
  createManagementRuntime,
  enqueueServerOperation,
  getGatewaySnapshot,
  getGatewayState,
  importMinecraftEvidence,
  inspectMinecraftCombination,
  processServerOperation,
  reconcileGatewayState,
  registerMinecraftCombination,
  setGatewayPolicy,
  setGatewayRoute,
  setManagedNode,
  setMinecraftAvailability,
  setPhysicalHost,
  setRuntimeMapping,
  setUserLimits,
  signMinecraftEvidence,
} from '../packages/server-management/src/index.js';
import {
  createMinecraftLiveLedger,
  guardMinecraftLiveAdapter,
  type MinecraftLiveAsset,
  type MinecraftLiveLedger,
  type MinecraftLivePlan,
  preflightMinecraftLive,
  proveMinecraftLiveAsset,
  readMinecraftLivePlan,
  saveMinecraftLiveLedger,
} from './m4-live.js';
import {
  captureMinecraftInstallation,
  type MinecraftInstalledFile,
  verifyMinecraftInstallationArtifacts,
} from './m4-live-installation.js';

type Profile = MinecraftLivePlan['profiles'][number]['request']['profile'];
const { createClient, ping } = minecraftProtocol;
type Prepared = Awaited<ReturnType<typeof preflightMinecraftLive>>['runtimes'][number];
interface Scenario {
  version: 1;
  schema: string;
  ownerId: string;
  sessionId: string;
  /** Isolated test-only signing/encryption secrets; this entire ledger is ignored and 0600. */
  evidenceKey: string;
  codecKey: string;
  gatewayId: string;
  hostId: string;
  nodeId: string;
  mappings: Partial<
    Record<Profile, { mappingId: string; choiceId: string; bootstrapMappingId: string }>
  >;
  completedBootstrap: Profile[];
  completedMinecraft: Profile[];
  activePhase?: string;
  stage?: string;
  failedAt?: string;
  assetCleanupAt?: string;
  cleanedAt?: string;
}
type Ledger = MinecraftLiveLedger & { scenario?: Scenario };
/** Fixture cadence respects the observed provider request budget without caching
 * inventory or extending any timeout, evidence age or routing lease. */
export const minecraftLiveGatewayDataPolicy = {
  ...defaultGatewayDataPolicy,
  pollIntervalMs: 5000,
  probeIntervalMs: 5000,
};
export function minecraftLiveProviderFailure(response: Response, input: string) {
  const scope = /\/api\/(application|client)\//.exec(new URL(input).pathname)?.[1];
  const retry = response.headers.get('retry-after');
  return {
    status: response.status,
    scope: scope ?? 'transfer',
    ...(retry && /^\d{1,5}$/.test(retry) && Number(retry) <= 86400
      ? { retryAfterSeconds: Number(retry) }
      : {}),
  };
}
/** This game exists only in the isolated validation schema. It does not claim M4 features. */
export const minecraftBootstrapManifest = gameManifestSchema.parse({
  id: 'm4-bootstrap',
  version: '1.0.0',
  nameKey: 'games.m4-bootstrap.name',
  capabilities: {
    console: true,
    files: true,
    backups: true,
    players: false,
    mods: false,
    worlds: false,
    idleDetection: false,
    gracefulStop: false,
    readiness: false,
    wake: 'manual',
  },
  connection: {
    mode: 'static-host-port',
    hostnameSettingKey: 'staticGameHostname',
    showPort: true,
  },
  ports: [{ role: 'game', transport: 'tcp', required: true }],
  runtimes: minecraftManifest.runtimes.map((runtime) => ({
    ...runtime,
    nameKey: `games.m4-bootstrap.runtimes.${runtime.id}`,
  })),
  wizard: { steps: [] },
  management: [],
  contentProviders: [],
  localizations: { namespace: 'games.m4-bootstrap', locales: ['en', 'it'] },
});
export interface MinecraftLiveScenarioContext {
  db: ReturnType<typeof createDatabase>['db'];
  context: AuthContext;
  env: Readonly<Record<string, string | undefined>>;
  runtime: Awaited<ReturnType<typeof createManagementRuntime>>;
  adapter: PterodactylAdapter;
  asset: MinecraftLiveAsset;
  choiceId: string;
  prepared: Prepared;
  ledger: MinecraftLiveLedger;
  pump(jobId: string, timeoutMs?: number): Promise<void>;
  operation(serverId: string, input: Record<string, unknown>): Promise<{ jobId: string }>;
  event(name: string, details?: Record<string, unknown>): Promise<void>;
  prove(asset: MinecraftLiveAsset): ReturnType<typeof proveMinecraftLiveAsset>;
}
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const defined = <T>(value: T | undefined | null): T => {
  assert(value !== undefined && value !== null, 'Required trusted state missing');
  return value;
};
type GatewayHealth = ReturnType<
  Awaited<ReturnType<typeof createGatewayRuntime>>['gateway']['health']
>;
/** Core readiness alone is insufficient after a policy generation changes. */
export function minecraftLiveReadyRoute(
  state: Pick<
    Awaited<ReturnType<typeof getGatewayState>>,
    'state' | 'generation' | 'sleepJobId' | 'sleepEligibleAt'
  >,
  snapshot: GatewaySnapshot,
  health: GatewayHealth,
  serverId: string,
  generation: string,
  now = Date.now(),
  mode: GatewayRoute['mode'] = 'online',
): GatewayRoute | undefined {
  if (
    state.state !== mode ||
    state.generation !== generation ||
    state.sleepJobId !== null ||
    !health.ready ||
    !health.controlAvailable ||
    health.stopping ||
    health.quiescentServers !== 0 ||
    health.revision !== snapshot.revision ||
    health.routes !== snapshot.routes.length ||
    !health.expiresAt ||
    Date.parse(health.expiresAt) <= now + 5000 ||
    Date.parse(snapshot.expiresAt) <= now + 5000
  )
    return undefined;
  const matches = snapshot.routes.filter((route) => route.serverId === serverId);
  const route = matches[0];
  if (
    matches.length !== 1 ||
    !route ||
    route.mode !== mode ||
    route.generation !== generation ||
    (route.sleepEligibleAt ?? null) !== state.sleepEligibleAt ||
    (mode === 'online' && route.sleepEligibleAt && Date.parse(route.sleepEligibleAt) <= now + 5000)
  )
    return undefined;
  return route;
}
export interface MinecraftLiveBackupJob {
  jobId: string;
  serverId: string;
  actorId: string;
  subjectId: string;
  resourceOwnerId: string;
  supportSessionId: string | null;
  state: string;
  action: string;
  plan: Record<string, unknown>;
  createdAt: Date;
  completedAt: Date | null;
}
export interface MinecraftLiveBackupPreparation {
  jobId: string | null;
  serverId: string;
  actorId: string | null;
  subjectId: string | null;
  supportSessionId: string | null;
  messageKey: string;
  data: Record<string, unknown>;
  createdAt: Date;
}
/** Test-only cleanup: inventory establishes completeness, never backup ownership. */
export async function cleanupMinecraftLiveBackups(options: {
  asset: MinecraftLiveAsset;
  ledger: MinecraftLiveLedger;
  ownerId: string;
  jobs: readonly MinecraftLiveBackupJob[];
  preparations: readonly MinecraftLiveBackupPreparation[];
  adapter: Pick<PterodactylAdapter, 'listBackups' | 'getBackup' | 'deleteBackup'>;
  prove(): Promise<unknown>;
  event(name: string, details: Record<string, unknown>): Promise<void>;
}) {
  const { asset, ledger, adapter } = options;
  const identifier = defined(asset.identifier);
  const assetTime = Date.parse(defined(asset.createdAt));
  assert(Number.isFinite(assetTime));
  assert(!asset.deletedAt, 'Cannot inspect backups after server deletion');
  assert(ledger.assets.includes(asset), 'Asset is absent from the protected ledger');
  const claims = new Map<string, { job: MinecraftLiveBackupJob; preparedAt: number }>();
  for (const job of options.jobs) {
    assert.equal(job.serverId, asset.managedServerId, 'Job belongs to another server');
    assert(['succeeded', 'failed'].includes(job.state), 'Active job forbids backup cleanup');
    const preparations = options.preparations.filter(
      (entry) =>
        entry.jobId === job.jobId &&
        entry.messageKey === 'servers.operation.effect_prepared' &&
        entry.data.phase === 'backup',
    );
    // A restore may reference a backup but never proves that this run created it.
    if (job.plan.backupId === undefined || preparations.length === 0) continue;
    assert.equal(job.actorId, options.ownerId, 'Backup job actor mismatch');
    assert.equal(job.subjectId, options.ownerId, 'Backup job subject mismatch');
    assert.equal(job.resourceOwnerId, options.ownerId, 'Backup job owner mismatch');
    assert.equal(job.supportSessionId, null, 'Support session cannot own this fixture');
    assert(job.completedAt && Number.isFinite(job.completedAt.getTime()));
    assert(job.createdAt.getTime() >= assetTime - 5000, 'Backup job predates this asset');
    const content = job.plan.minecraftContent as { backupBefore?: unknown } | undefined;
    assert(
      job.action === 'backup' ||
        (['reinstall', 'wipe', 'delete'].includes(job.action) && job.plan.backupBefore === true) ||
        (job.action === 'minecraft-content' && content?.backupBefore === true),
      'Job did not request backup creation',
    );
    assert.equal(preparations.length, 1, 'Ambiguous backup creation attempts');
    const prepared = defined(preparations[0]);
    assert.equal(prepared.serverId, asset.managedServerId);
    assert.equal(prepared.actorId, options.ownerId);
    assert.equal(prepared.subjectId, options.ownerId);
    assert.equal(prepared.supportSessionId, null);
    const preparedAt = prepared.createdAt.getTime();
    assert(
      Number.isFinite(preparedAt) &&
        preparedAt >= job.createdAt.getTime() - 5000 &&
        preparedAt <= job.completedAt.getTime(),
      'Backup creation chronology is invalid',
    );
    const backupId = backupSchema.shape.uuid.parse(job.plan.backupId);
    assert(!claims.has(backupId), 'Backup is claimed by multiple creation jobs');
    claims.set(backupId, { job, preparedAt });
  }
  const inventory = async () => {
    await options.prove();
    const entries = await adapter.listBackups(identifier);
    assert.equal(new Set(entries.map((entry) => entry.uuid)).size, entries.length);
    assert(
      entries.every((entry) => claims.has(entry.uuid)),
      'Unknown backup forbids backup and server deletion',
    );
    return entries;
  };
  // Check the entire inventory before deleting even a conclusively owned backup.
  const initial = await inventory();
  for (const [backupId, { job, preparedAt }] of claims) {
    const scope = {
      runId: ledger.runId,
      serverId: asset.managedServerId,
      serverUuid: defined(asset.uuid),
      externalId: asset.externalId,
      apiIdentitySha256: ledger.apiIdentitySha256,
      apiAccountId: ledger.apiAccountId,
      jobId: job.jobId,
      backupId,
    };
    const validate = (value: unknown) => {
      const backup = backupSchema.parse(value);
      assert.equal(backup.uuid, backupId);
      // The name corroborates the persisted UUID and scoped creation event only.
      assert.equal(backup.name, `nickhosting-operation-${job.jobId}`);
      assert(!backup.is_locked, 'Locked backup requires independent Owner review');
      assert(backup.completed_at, 'Incomplete backup forbids cleanup');
      const created = Date.parse(backup.created_at);
      const completed = Date.parse(backup.completed_at);
      assert(
        Number.isFinite(created) &&
          Number.isFinite(completed) &&
          created >= preparedAt - 5000 &&
          created >= assetTime - 5000 &&
          completed >= created &&
          completed <= Date.now() + 5000,
        'Backup creation metadata does not match this test run',
      );
      return backup;
    };
    const previous = ledger.events.filter(
      (entry) =>
        entry.event === 'cleanup.backup.delete-intent' &&
        Object.entries(scope).every(([key, value]) => entry.details?.[key] === value),
    );
    assert(previous.length <= 1, 'Multiple deletion intents require independent review');
    const confirmAbsent = async () => {
      await options.prove();
      try {
        await adapter.getBackup(identifier, backupId);
      } catch (error) {
        if (
          error instanceof PterodactylError &&
          error.scope === 'client' &&
          error.reason === 'not_found' &&
          error.upstreamStatus === 404
        ) {
          assert(!(await inventory()).some((entry) => entry.uuid === backupId));
          return;
        }
        throw error;
      }
      throw new Error('Backup deletion is not confirmed by the provider');
    };
    if (!initial.some((entry) => entry.uuid === backupId)) {
      assert.equal(previous.length, 1, 'Missing backup has no durable deletion intent');
      validate(previous[0]?.details?.backup);
      await confirmAbsent();
      await options.event('cleanup.backup.provider-absence-reconciled', scope);
      continue;
    }
    assert.equal(previous.length, 0, 'Unresolved deletion intent requires independent review');
    await options.prove();
    const backup = validate(await adapter.getBackup(identifier, backupId));
    await options.event('cleanup.backup.provenance-confirmed', { ...scope, backup });
    await inventory();
    await options.prove();
    assert.deepEqual(
      validate(await adapter.getBackup(identifier, backupId)),
      backup,
      'Backup changed before deletion',
    );
    // event() fsyncs the protected ledger; the guarded adapter proves ownership again.
    await options.event('cleanup.backup.delete-intent', { ...scope, backup });
    try {
      await adapter.deleteBackup(identifier, backupId);
      await confirmAbsent();
    } catch {
      await options.event('cleanup.backup.deletion-uncertain', scope);
      throw new Error('Backup deletion is uncertain; retain server and schema for review');
    }
    await options.event('cleanup.backup.provider-deletion-confirmed', scope);
  }
  assert.equal((await inventory()).length, 0, 'Backups remain before server deletion');
  await options.event('cleanup.backups.provider-inventory-empty', {
    serverId: asset.managedServerId,
    serverUuid: asset.uuid,
    verifiedBackupCount: claims.size,
    directStorageErasureVerified: false,
  });
}
class MinecraftLiveClientFailure extends Error {
  constructor(
    readonly category:
      | 'timeout'
      | 'transport_error'
      | 'ended_before_expected_state'
      | 'ended_after_play'
      | 'unexpected_play'
      | 'unexpected_disconnect'
      | 'oversized_disconnect'
      | 'invalid_protocol_evidence',
    readonly expected: 'play' | 'disconnect',
    readonly clientState: string,
  ) {
    super('Independent Minecraft client did not reach the expected state');
  }
}
/** Called only after Core has conclusively removed each ledger-owned asset. */
export async function finalizeMinecraftLiveCleanup(
  scenario: Pick<Scenario, 'schema' | 'activePhase' | 'failedAt' | 'assetCleanupAt' | 'cleanedAt'>,
  assets: readonly Pick<MinecraftLiveAsset, 'deletedAt'>[],
  options: {
    retainSchema: boolean;
    event(name: string, details?: Record<string, unknown>): Promise<void>;
    dropSchema(): Promise<void>;
    save(): Promise<void>;
  },
) {
  assert(
    assets.every((asset) => asset.deletedAt),
    'Unresolved asset forbids schema cleanup',
  );
  assert.match(scenario.schema, /^nh_test_[a-f0-9]{32}$/);
  if (options.retainSchema) {
    scenario.assetCleanupAt = new Date().toISOString();
    await options.event('cleanup.assets-confirmed-schema-retained', {
      schema: scenario.schema,
      failedAt: scenario.failedAt ?? null,
      originalJobsRetained: true,
      bootstrapEvidenceRetained: true,
      automaticRetry: false,
    });
  } else {
    await options.event('cleanup.schema.approved', { schema: scenario.schema });
    await options.dropSchema();
    scenario.cleanedAt = new Date().toISOString();
  }
  delete scenario.activePhase;
  await options.save();
}
/** Retain only the signed immutable set; companion configuration is validated
 * semantically by the capture helper and must not become a new raw-hash contract. */
export function promoteMinecraftInstallationEvidence(
  prior: NonNullable<MinecraftEvidence['server']>['installedFiles'],
  current: readonly MinecraftInstalledFile[],
): MinecraftInstalledFile[] {
  assert(prior?.length, 'Missing signed immutable installation evidence');
  assert.equal(new Set(prior.map((file) => file.path)).size, prior.length);
  assert.equal(new Set(current.map((file) => file.path)).size, current.length);
  assert.deepEqual(
    [...prior.map((file) => file.path)].sort(),
    [...current.map((file) => file.path)].sort(),
    'Installed immutable entry set changed',
  );
  return prior.map((signed) => {
    const actual = defined(current.find((file) => file.path === signed.path));
    assert.equal(actual.role, signed.role, 'Installed artifact role changed');
    if (signed.role === 'fabric-launcher') {
      assert.equal(actual.jarEntriesSha256, signed.jarEntriesSha256);
      assert.equal(actual.minecraftServerPath, signed.minecraftServerPath);
      assert(signed.jarEntriesSha256 && signed.minecraftServerPath);
      return {
        ...actual,
        role: signed.role,
        jarEntriesSha256: signed.jarEntriesSha256,
        minecraftServerPath: signed.minecraftServerPath,
      };
    }
    assert.equal(actual.sha256, signed.sha256, 'Immutable installed artifact changed');
    assert.equal(actual.size, signed.size, 'Immutable installed artifact size changed');
    return { path: actual.path, sha256: actual.sha256, size: actual.size };
  });
}
function mappingBinding(
  profile: MinecraftLivePlan['profiles'][number],
  runtime: Prepared['runtime'],
  variables: { env_variable: string; default_value: string | null }[],
): MinecraftRuntimeMapping {
  const common = {
    profile: profile.request.profile,
    release: runtime.release,
    image: profile.image,
    imageJavaMajor: runtime.javaMajor,
    declaredEggVariables: variables.map((variable) => variable.env_variable),
    installationKind: runtime.installation.kind,
    supportedProperties: [],
  };
  const binding = ((): MinecraftRuntimeMapping => {
    switch (runtime.profile) {
      case 'vanilla':
        return {
          ...common,
          bindings: { release: 'VANILLA_VERSION' },
          fixedVariables: { SERVER_JARFILE: 'server.jar' },
          artifactPaths: { server: 'server.jar' },
        };
      case 'paper':
        return {
          ...common,
          bindings: { release: 'MINECRAFT_VERSION', buildId: 'BUILD_NUMBER' },
          fixedVariables: { SERVER_JARFILE: 'server.jar', DL_PATH: '' },
          artifactPaths: { server: 'server.jar' },
        };
      case 'folia':
        return {
          ...common,
          bindings: {
            release: 'MINECRAFT_VERSION',
            buildId: 'BUILD_NUMBER',
            serverArtifactUrl: 'DL_PATH',
          },
          fixedVariables: { SERVER_JARFILE: 'server.jar' },
          artifactPaths: { server: 'server.jar' },
        };
      case 'fabric':
        return {
          ...common,
          bindings: {
            release: 'MC_VERSION',
            loaderVersion: 'LOADER_VERSION',
            installerVersion: 'FABRIC_VERSION',
          },
          fixedVariables: { SERVER_JARFILE: 'server.jar' },
          artifactPaths: { server: 'server.jar' },
        };
      case 'forge':
        return {
          ...common,
          bindings: { release: 'MC_VERSION', loaderCoordinate: 'FORGE_VERSION' },
          fixedVariables: { SERVER_JARFILE: 'server.jar', BUILD_TYPE: 'recommended' },
          artifactPaths: { server: 'server.jar' },
        };
    }
  })();
  const bound = new Set(Object.values(binding.bindings));
  const fixedVariables: Record<string, string> = { ...binding.fixedVariables };
  for (const variable of variables) {
    if (bound.has(variable.env_variable) || variable.env_variable in fixedVariables) continue;
    assert(variable.default_value !== null, 'Unbound egg variable requires an explicit value');
    fixedVariables[variable.env_variable] = variable.default_value;
  }
  return { ...binding, fixedVariables };
}
function forgeArgsPath(runtime: Prepared['runtime']): string {
  assert(runtime.profile === 'forge' && runtime.loaderVersion);
  return `libraries/net/minecraftforge/forge/${runtime.release}-${runtime.loaderVersion}/unix_args.txt`;
}

/** Read-only adapter configuration discovers the exact Wings origin; never prints its token. */
async function configuredAdapter(
  plan: MinecraftLivePlan,
  failure?: (details: ReturnType<typeof minecraftLiveProviderFailure>) => Promise<void>,
) {
  const secrets = parseEnv(await readFile(plan.credentialsFile, 'utf8'));
  const shared = {
    baseURL: defined(secrets.NH_PTERODACTYL_BASE_URL),
    applicationKey: defined(secrets.NH_PTERODACTYL_APPLICATION_KEY),
    clientKey: defined(secrets.NH_PTERODACTYL_CLIENT_KEY),
    containerObserver: createContainerObserver(plan.observer.dockerSocket),
    fetcher: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init);
      if (!response.ok && failure)
        await failure(
          minecraftLiveProviderFailure(
            response,
            input instanceof Request ? input.url : String(input),
          ),
        );
      return response;
    },
  };
  const discovery = createPterodactylAdapter(shared),
    node = await discovery.getNode(plan.nodeId);
  assert.equal(node.uuid, plan.nodeUuid);
  const wings = new URL(`${node.scheme}://${node.fqdn}:${node.daemon_listen}`);
  return createPterodactylAdapter({
    ...shared,
    webSocketOrigins: [wings.origin.replace(/^http/, 'ws')],
    downloadOrigins: [wings.origin],
    uploadOrigins: [wings.origin],
  });
}

async function openPreviousDatabase(schema: string) {
  assert.match(schema, /^nh_test_[a-f0-9]{32}$/);
  const value = defined(process.env.NH_TEST_DATABASE_URL),
    url = new URL(value);
  assert(
    ['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_DATABASE_HOST].includes(
      url.hostname,
    ),
  );
  assert.equal(url.pathname, '/nickhosting_test');
  assert.equal(url.username, 'nickhosting_test');
  const database = createDatabase(value, { options: `-c search_path=${schema}`, max: 15 });
  const exists = await database.pool.query(
    'select 1 from information_schema.schemata where schema_name=$1',
    [schema],
  );
  assert.equal(exists.rowCount, 1, 'Recorded isolated schema missing');
  await migrate(database.pool);
  return { ...database, schema };
}

async function newScenarioDatabase() {
  const schema = `nh_test_${randomUUID().replaceAll('-', '')}`;
  const value = defined(process.env.NH_TEST_DATABASE_URL),
    url = new URL(value);
  assert(
    ['127.0.0.1', 'localhost', '[::1]', process.env.NH_TEST_VERIFIED_DATABASE_HOST].includes(
      url.hostname,
    ),
  );
  assert.equal(url.pathname, '/nickhosting_test');
  assert.equal(url.username, 'nickhosting_test');
  const admin = createDatabase(value, { max: 1 });
  try {
    await admin.pool.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.db.destroy();
  }
  return openPreviousDatabase(schema);
}

export interface MinecraftLiveClientProtocolEvidence {
  readonly release: string;
  readonly protocolId: number;
  readonly nextState: 2;
  readonly source: 'outbound-set_protocol';
}
/** 1.68.0 resolves options.protocolVersion, but does not set Client.protocolVersion.
 * Observe the library's actual handshake instead of copying our registry value.
 * https://github.com/PrismarineJS/node-minecraft-protocol/blob/1.68.0/src/client/setProtocol.js
 */
export function createMinecraftLiveProtocolClient(
  address: string,
  port: number,
  release: string,
  username: string,
) {
  const client = createClient({
    host: address,
    port,
    version: release,
    username,
    auth: 'offline',
    profilesFolder: false,
    hideErrors: true,
  });
  let captured: MinecraftLiveClientProtocolEvidence | undefined;
  let handshakes = 0;
  const originalWrite = client.write.bind(client);
  // This factory deliberately uses ordinary asynchronous TCP connection, not
  // options.stream/connect hooks. The wrapper is installed before connect fires.
  client.write = (name: string, parameters: unknown) => {
    if (name !== 'set_protocol') {
      originalWrite(name, parameters);
      return;
    }
    handshakes++;
    captured = undefined;
    const packet = parameters as { protocolVersion?: unknown; nextState?: unknown } | null;
    const valid =
      handshakes === 1 &&
      client.state === 'handshaking' &&
      client.serializer.writable &&
      packet !== null &&
      typeof packet === 'object' &&
      typeof packet.protocolVersion === 'number' &&
      Number.isSafeInteger(packet.protocolVersion) &&
      packet.protocolVersion >= 0 &&
      packet.protocolVersion <= 0x7fffffff &&
      packet.nextState === 2;
    // Do not rewrite any packet or replace the library's serializer/authentication.
    originalWrite(name, parameters);
    if (valid)
      captured = Object.freeze({
        release: client.version,
        protocolId: packet.protocolVersion as number,
        nextState: 2,
        source: 'outbound-set_protocol',
      });
  };
  return {
    client,
    protocolEvidence(): MinecraftLiveClientProtocolEvidence {
      assert(handshakes === 1 && captured, 'No unique valid emitted login handshake');
      return captured;
    },
  };
}

/** Independent open-source protocol client. Offline authentication is configured
 * explicitly on the owned fixture, never emulated by Gateway or enabled in product settings. */
async function independentClient(
  address: string,
  port: number,
  release: string,
  username: string,
  expected: 'play' | 'disconnect',
) {
  return new Promise<{
    client: Client;
    protocol: MinecraftLiveClientProtocolEvidence;
    disconnect?: string;
  }>((resolveClient, reject) => {
    const observed = createMinecraftLiveProtocolClient(address, port, release, username);
    const { client } = observed;
    let settled = false;
    const timer = setTimeout(() => fail('timeout'), 60000);
    function fail(category: MinecraftLiveClientFailure['category']) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      const state = ['handshaking', 'status', 'login', 'configuration', 'play'].includes(
        client.state,
      )
        ? client.state
        : 'unknown';
      reject(new MinecraftLiveClientFailure(category, expected, state));
    }
    function finish(disconnect?: string) {
      let protocol: MinecraftLiveClientProtocolEvidence;
      try {
        protocol = observed.protocolEvidence();
      } catch {
        fail('invalid_protocol_evidence');
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (disconnect !== undefined) client.end();
      resolveClient({ client, protocol, ...(disconnect !== undefined ? { disconnect } : {}) });
    }
    client.on('error', () => fail('transport_error'));
    client.on('end', () => {
      if (!settled) fail('ended_before_expected_state');
    });
    client.on('playerJoin', () => {
      if (settled) return;
      if (expected !== 'play') {
        fail('unexpected_play');
        return;
      }
      finish();
    });
    client.on('packet', (data: unknown, metadata) => {
      if (settled || !['kick_disconnect', 'disconnect'].includes(metadata.name)) return;
      if (expected !== 'disconnect') {
        fail('unexpected_disconnect');
        return;
      }
      const disconnect = JSON.stringify(data);
      if (disconnect.length > 65536) {
        fail('oversized_disconnect');
        return;
      }
      finish(disconnect);
    });
  });
}

export async function runMinecraftLiveScenario(options: {
  planPath: string;
  phase: 'bootstrap' | 'minecraft' | 'cleanup';
  profile: Profile;
  ledgerPath?: string;
  ownerApproved: boolean;
  /** Explicit cleanup-only option; preserves terminal failures and all bootstrap evidence. */
  retainSchema?: boolean;
  /** Trusted local test extension, never JSON/config input. Runs stopped after protocol checks. */
  afterProtocol?: (context: MinecraftLiveScenarioContext) => Promise<void>;
}) {
  assert(options.ownerApproved, 'Explicit reviewed scenario execution required');
  assert(!options.retainSchema || options.phase === 'cleanup', 'Schema retention is cleanup-only');
  assert(minecraftManifest.runtimes.some((runtime) => runtime.id === options.profile));
  const { plan, planSha256 } = await readMinecraftLivePlan(options.planPath);
  assert(
    plan.approval.endpoints &&
      plan.approval.eula &&
      plan.approval.externalExposureAcknowledged &&
      plan.approval.reference,
  );
  // Stop/delete must remain available when capacity or an unrelated upstream
  // version service fails. Cleanup uses fresh ownership and observer fences only.
  if (options.phase === 'cleanup') assert(options.ledgerPath, 'Cleanup requires a recorded run');
  const preflight =
    options.phase === 'cleanup'
      ? undefined
      : await preflightMinecraftLive(plan, !options.ledgerPath, true);
  let ledger: Ledger, path: string;
  if (options.ledgerPath) {
    path = resolve(options.ledgerPath);
    assert.equal(resolve('mountdata/test-assets'), resolve(path, '..'));
    assert.match(path.split('/').at(-1) ?? '', /^m4-live-[a-f0-9-]{36}\.json$/);
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
    ledger = JSON.parse(await readFile(path, 'utf8')) as Ledger;
    assert.equal(ledger.version, 1);
    assert.equal(ledger.planSha256, planSha256);
    assert.equal(ledger.apiIdentitySha256, plan.expectedApiIdentitySha256);
    const secrets = parseEnv(await readFile(plan.credentialsFile, 'utf8'));
    assert.equal(
      ledger.apiOriginSha256,
      digest(new URL(defined(secrets.NH_PTERODACTYL_BASE_URL)).origin),
    );
    assert(ledger.scenario && !ledger.scenario.cleanedAt, 'Scenario state unavailable');
  } else {
    assert.equal(options.phase, 'bootstrap', 'Start with a separately labeled bootstrap');
    const created = await createMinecraftLiveLedger(plan, planSha256);
    ledger = created.ledger;
    path = created.path;
  }
  // A retained ledger can span reviewed fixes. Attribute each invocation to its
  // actual source rather than reusing the original bootstrap's Git identity.
  const execution = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        encoding: 'utf8',
      }).trim().length > 0,
    files: Object.fromEntries(
      await Promise.all(
        [
          'scripts/m4-live.ts',
          'scripts/m4-live-scenario.ts',
          'scripts/m4-live-installation.ts',
          'scripts/m4-live-content.ts',
        ].map(async (file) => [file, digest(await readFile(file))]),
      ),
    ),
  };
  assert.match(execution.head, /^[a-f0-9]{40}$/);
  ledger.events.push({
    at: new Date().toISOString(),
    event: 'scenario.execution-code',
    details: { phase: options.phase, profile: options.profile, ...execution },
  });
  await saveMinecraftLiveLedger(path, ledger);
  const database = ledger.scenario
    ? await openPreviousDatabase(ledger.scenario.schema)
    : await newScenarioDatabase();
  const db = database.db;
  if (!ledger.scenario) {
    ledger.scenario = {
      version: 1,
      schema: database.schema,
      ownerId: randomUUID(),
      sessionId: randomUUID(),
      evidenceKey: randomBytes(32).toString('hex'),
      codecKey: randomBytes(32).toString('hex'),
      gatewayId: randomUUID(),
      hostId: '',
      nodeId: '',
      mappings: {},
      completedBootstrap: [],
      completedMinecraft: [],
    };
    await saveMinecraftLiveLedger(path, ledger);
  }
  const scenario = ledger.scenario;
  assert.equal(scenario.version, 1);
  const save = () => saveMinecraftLiveLedger(path, ledger);
  const stage = async (name: string) => {
    scenario.stage = name;
    await save();
  };
  const event = async (name: string, details?: Record<string, unknown>) => {
    ledger.events.push({ at: new Date().toISOString(), event: name, details });
    await save();
    // Details may contain private topology. Only the event name is public console evidence.
    console.log(JSON.stringify({ event: name, runId: ledger.runId }));
  };
  const context: AuthContext = {
    actorUserId: scenario.ownerId,
    subjectUserId: scenario.ownerId,
    role: 'owner',
    sessionType: 'regular',
    ownerElevation: false,
    [authSessionId]: scenario.sessionId,
  };
  const env: Record<string, string> = {
    NH_OBSERVER_ID: ledger.runId,
    NH_DOCKER_OBSERVER_SOCKET: plan.observer.dockerSocket,
    NH_MINECRAFT_METADATA_USER_AGENT: plan.metadataUserAgent,
    NH_MINECRAFT_EVIDENCE_KEY: scenario.evidenceKey,
    NH_MINECRAFT_CONTENT_ROOT: './mountdata/test-assets/m4-content',
    NH_MINECRAFT_SOURCE_ROOT: './mountdata/test-assets/m4-sources',
    NH_GATEWAY_ENABLED: 'true',
    NH_GATEWAY_ID: scenario.gatewayId,
    NH_GATEWAY_CORE_URL: 'http://127.0.0.1',
    NH_GATEWAY_CONTROL_TOKEN: randomBytes(32).toString('base64url'),
    NH_GATEWAY_DATA_POLICY: JSON.stringify(minecraftLiveGatewayDataPolicy),
    NH_GATEWAY_NETWORK_POLICY: JSON.stringify(plan.networkPolicy),
    NH_GATEWAY_OBSERVER: JSON.stringify(plan.observer),
    NH_GATEWAY_NODE_PROBES: JSON.stringify({
      [plan.nodeId]: { port: plan.nodeProbe.port, transport: 'tcp' },
    }),
  };
  const raw = await configuredAdapter(plan, (details) => event('provider.http-failure', details)),
    adapter = guardMinecraftLiveAdapter(raw, plan, ledger, path);
  const observer = createContainerObserver(plan.observer.dockerSocket);
  const codec = new SecretCodec({
    activeKeyId: 'm4-test',
    keys: { 'm4-test': Buffer.from(scenario.codecKey, 'hex') },
  });
  const runtime = await createManagementRuntime({
    db,
    codec,
    env,
    adapter,
    containerObserver: observer,
  });
  let gateway: Awaited<ReturnType<typeof createGatewayRuntime>> | undefined;
  let consoleRelay: Awaited<ReturnType<PterodactylAdapter['relayConsole']>> | undefined;
  let joinedClient: Client | undefined;
  let joinedProtocol: MinecraftLiveClientProtocolEvidence | undefined;
  let postWakeProtocol: MinecraftLiveClientProtocolEvidence | undefined;
  const limits = {
    memory: plan.limits.memoryMiB,
    cpu: plan.limits.cpuPercent,
    disk: plan.limits.diskMiB,
    swap: 0,
    io: 500,
  };
  const assetFor = (serverId: string) =>
    defined(ledger.assets.find((asset) => asset.managedServerId === serverId));
  const prove = (asset: MinecraftLiveAsset) => proveMinecraftLiveAsset(raw, plan, ledger, asset);
  async function pump(jobId: string, timeoutMs = 900000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await runtime.refreshObservations();
      await processServerOperation(db, jobId, runtime.lifecycle);
      const job = await db
        .selectFrom('operation_jobs')
        .selectAll()
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow();
      if (job.state === 'succeeded') return;
      if (job.state === 'failed')
        throw new DomainError(
          job.error_code === 'resources_unavailable'
            ? 'resources_unavailable'
            : 'integration_unavailable',
        );
      await delay(1500);
    }
    throw new Error('Operation deadline exceeded; preserve ledger and inspect');
  }
  async function operation(serverId: string, input: Record<string, unknown>) {
    await prove(assetFor(serverId));
    await runtime.refreshObservations();
    const queued = await enqueueServerOperation(
      db,
      context,
      serverId,
      { idempotencyKey: randomUUID(), ...input },
      env,
    );
    await event(`operation.${String(input.action)}.queued`, { serverId, jobId: queued.jobId });
    await pump(queued.jobId);
    return queued;
  }
  async function create(
    mappingId: string,
    minecraft?: { choiceId: string; configuration: { eula: true } },
  ) {
    assert(
      ledger.assets.every((asset) => asset.deletedAt),
      'Previous test server is unresolved',
    );
    await runtime.refreshObservations();
    const result = await createManagedServer(
      db,
      adapter,
      context,
      {
        idempotencyKey: randomUUID(),
        mappingId,
        name: `Codex M4 ${options.phase} ${options.profile} ${ledger.runId.slice(-8)}`,
        limits,
        autoStart: false,
        ...(minecraft ? { minecraft } : {}),
      },
      env,
    );
    const row = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', result.serverId)
      .executeTakeFirstOrThrow();
    const asset: MinecraftLiveAsset = {
      managedServerId: row.id,
      externalId: row.external_id,
      profile: options.profile,
      requestedAt: new Date().toISOString(),
    };
    ledger.assets.push(asset);
    await save();
    await pump(result.jobId);
    await prove(asset);
    assert.equal((await adapter.getResources(defined(asset.identifier))).current_state, 'offline');
    await event(`${options.phase}.provision.installed-offline`, {
      serverId: row.id,
      uuid: asset.uuid,
    });
    return asset;
  }
  async function remove(asset: MinecraftLiveAsset) {
    await prove(asset);
    await operation(asset.managedServerId, { action: 'stop' });
    const [jobs, preparations] = await Promise.all([
      db
        .selectFrom('server_operations as operation')
        .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
        .select([
          'job.id as jobId',
          'operation.server_id as serverId',
          'job.actor_id as actorId',
          'job.subject_id as subjectId',
          'job.resource_owner_id as resourceOwnerId',
          'job.support_session_id as supportSessionId',
          'job.state',
          'operation.action',
          'operation.plan',
          'job.created_at as createdAt',
          'job.completed_at as completedAt',
        ])
        .where('operation.server_id', '=', asset.managedServerId)
        .execute(),
      db
        .selectFrom('server_events')
        .select([
          'job_id as jobId',
          'server_id as serverId',
          'actor_id as actorId',
          'subject_id as subjectId',
          'support_session_id as supportSessionId',
          'message_key as messageKey',
          'data',
          'created_at as createdAt',
        ])
        .where('server_id', '=', asset.managedServerId)
        .where('message_key', '=', 'servers.operation.effect_prepared')
        .execute(),
    ]);
    await cleanupMinecraftLiveBackups({
      asset,
      ledger,
      ownerId: scenario.ownerId,
      jobs,
      preparations,
      adapter,
      prove: () => prove(asset),
      event,
    });
    await operation(asset.managedServerId, {
      action: 'delete',
      confirm: true,
      backupBefore: false,
    });
    assert(asset.deletedAt);
    assert.equal(await raw.findServerByExternalId(asset.externalId), null);
    await event('cleanup.server.confirmed', { uuid: asset.uuid });
  }
  async function ready(asset: MinecraftLiveAsset, route: GatewayRoute, prepared: Prepared) {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      await prove(asset);
      const result = await probeMinecraftStatus(
        { route, signal: AbortSignal.timeout(5000) },
        prepared.protocol,
      );
      if (result.ready) return result;
      await delay(1500);
    }
    throw new Error('Real Minecraft readiness deadline exceeded');
  }
  try {
    scenario.activePhase = `${options.phase}:${options.profile}`;
    await save();
    if (options.phase === 'cleanup') {
      const failures = ledger.assets.length
        ? await db
            .selectFrom('operation_jobs as job')
            .innerJoin('server_operations as operation', 'operation.job_id', 'job.id')
            .selectAll('job')
            .where(
              'operation.server_id',
              'in',
              ledger.assets.map((asset) => asset.managedServerId),
            )
            .where('job.state', '=', 'failed')
            .execute()
        : [];
      await event('cleanup.original-terminal-failures-retained', {
        retainSchema: options.retainSchema === true,
        failures,
      });
      for (const asset of ledger.assets.filter((row) => !row.deletedAt)) await remove(asset);
      const remaining = await raw.listApplicationServers();
      for (const asset of ledger.assets) {
        const row = await db
          .selectFrom('managed_servers')
          .select(['deleted_at', 'active_operation_id'])
          .where('id', '=', asset.managedServerId)
          .executeTakeFirstOrThrow();
        assert(row.deleted_at && !row.active_operation_id, 'Core deletion remains unresolved');
        assert.equal(await raw.findServerByExternalId(asset.externalId), null);
        assert(
          !remaining.some((remote) => remote.id === asset.id || remote.uuid === asset.uuid),
          'Provider still contains a recorded test asset',
        );
        assert(await observer.stopped(defined(asset.uuid), 'server'));
        assert(await observer.stopped(defined(asset.uuid), 'installer'));
      }
      for (const original of failures)
        assert.deepEqual(
          await db
            .selectFrom('operation_jobs')
            .selectAll()
            .where('id', '=', original.id)
            .executeTakeFirstOrThrow(),
          original,
          'Original failed job changed during cleanup',
        );
      await finalizeMinecraftLiveCleanup(scenario, ledger.assets, {
        retainSchema: options.retainSchema === true,
        event,
        dropSchema: async () => {
          await database.pool.query(`DROP SCHEMA "${scenario.schema}" CASCADE`);
        },
        save,
      });
      return {
        ledgerPath: path,
        phase: options.phase,
        schemaRetained: options.retainSchema === true,
      };
    }
    if (!scenario.hostId) {
      await stage('local.identity.create');
      await database.pool.query(
        'insert into "user"(id,name,email,role,"emailVerified") values($1,$2,$3,$4,true)',
        [scenario.ownerId, 'Isolated M4 tester', `${scenario.ownerId}@example.test`, 'owner'],
      );
      await database.pool.query(
        `insert into session(id,token,"userId","expiresAt") values($1,$2,$3,now()+interval '24 hours')`,
        [scenario.sessionId, randomUUID(), scenario.ownerId],
      );
      for (const manifest of [minecraftManifest, minecraftBootstrapManifest]) {
        await stage(`local.manifest.${manifest.id}.register`);
        await db
          .insertInto('game_integrations')
          .values({ id: manifest.id, version: manifest.version, manifest })
          .execute();
        await db
          .insertInto('game_rollouts')
          .values({
            integration_id: manifest.id,
            state: 'private-testing',
            allowlist: [scenario.ownerId],
          })
          .execute();
      }
      await stage('local.host.configure');
      const host = await setPhysicalHost(db, context, {
        name: 'Isolated M4 real-server validation',
        memoryLimitMiB: Math.floor(totalmem() / 1048576),
        cpuLimitPercent: cpus().length * 100,
        storagePoolMiB: plan.limits.diskHeadroomMiB + plan.limits.diskMiB * 2,
        memoryHeadroomMiB: plan.limits.memoryHeadroomMiB,
        cpuHeadroomPercent: 200,
        diskHeadroomMiB: plan.limits.diskHeadroomMiB,
        localDiskPath: plan.diskPath,
        observerId: ledger.runId,
        ...(plan.uploadPolicy ? { uploadPolicy: plan.uploadPolicy } : {}),
      });
      scenario.hostId = host.id;
      await save();
      await stage('local.node.configure');
      const node = await setManagedNode(db, adapter, context, {
        physicalHostId: host.id,
        pterodactylNodeId: plan.nodeId,
        provisionUserId: plan.expectedApiAccountId,
        memoryOverheadPercent: 200,
        backendAllocationPool: plan.backendAllocationPool,
      });
      scenario.nodeId = node.id;
      await save();
      await stage('local.user-limits.configure');
      await setUserLimits(db, context, {
        userId: scenario.ownerId,
        memoryMiB: limits.memory,
        cpuPercent: limits.cpu,
        storageMiB: limits.disk * 2,
        reason: 'Owner-approved sequential M4 validation envelope',
      });
    }
    assert(scenario.nodeId, 'Interrupted setup requires coordinator inspection');
    env.NH_GATEWAY_PHYSICAL_HOST_ID = scenario.hostId;
    for (const profile of plan.profiles) {
      if (scenario.mappings[profile.request.profile]) continue;
      const prepared = defined(
        defined(preflight).runtimes.find(
          (entry) => entry.runtime.profile === profile.request.profile,
        ),
      );
      const egg = await adapter.getEgg(profile.nestId, profile.eggId);
      const binding = mappingBinding(
        profile,
        prepared.runtime,
        egg.relationships?.variables?.data.map((row) => row.attributes) ?? [],
      );
      const environment = validateMinecraftRuntimeMapping(prepared.runtime, binding);
      const input = {
        gameId: 'minecraft-java',
        runtimeId: profile.request.profile,
        nodeId: scenario.nodeId,
        nestId: profile.nestId,
        eggId: profile.eggId,
        dockerImage: profile.image,
        startup:
          prepared.runtime.profile === 'forge'
            ? `java -Xms128M -XX:MaxRAMPercentage=95.0 -Dterminal.jline=false -Dterminal.ansi=true @${forgeArgsPath(prepared.runtime)} nogui`
            : egg.startup,
        environment,
        portRoles: [{ role: 'game', protocols: ['tcp'], primary: true }],
        featureLimits: { databases: 0, allocations: 1, backups: 1 },
      };
      await stage(`local.mapping.${profile.request.profile}.register`);
      const mapping = await setRuntimeMapping(db, adapter, context, input);
      await stage(`local.combination.${profile.request.profile}.register`);
      const choice = await registerMinecraftCombination(
        db,
        adapter,
        context,
        { mappingId: mapping.id, runtime: profile.request, binding },
        env,
      );
      await stage(`local.bootstrap-mapping.${profile.request.profile}.register`);
      const bootstrap = await setRuntimeMapping(db, adapter, context, {
        ...input,
        gameId: 'm4-bootstrap',
        // Same exact reviewed mapping; the yolk entrypoint already prints Java.
      });
      scenario.mappings[profile.request.profile] = {
        mappingId: mapping.id,
        choiceId: choice.id,
        bootstrapMappingId: bootstrap.id,
      };
      await save();
    }
    const registered = defined(scenario.mappings[options.profile]);
    const prepared = defined(
      defined(preflight).runtimes.find((entry) => entry.runtime.profile === options.profile),
    );
    const pin = defined(
      backendAllocationPoolSchema.parse(plan.backendAllocationPool).allocations[0],
    );
    if (options.phase === 'bootstrap') {
      assert(!scenario.completedBootstrap.includes(options.profile), 'Bootstrap already completed');
      await stage('bootstrap.server.create');
      const asset = await create(registered.bootstrapMappingId);
      const choice = await inspectMinecraftCombination(db, registered.choiceId, env);
      const captureOptions = {
        adapter,
        identifier: defined(asset.identifier),
        runtime: prepared.runtime,
        binding: choice.row.binding as MinecraftRuntimeMapping,
        assertOwned: async () => {
          await prove(asset);
        },
        workDirectory: resolve('mountdata/test-assets'),
        userAgent: plan.metadataUserAgent,
      };
      await stage('bootstrap.installation.verify-before-start');
      const prestart = await verifyMinecraftInstallationArtifacts(captureOptions);
      if (prepared.runtime.profile === 'forge')
        assert(
          prestart.installedFiles.some((file) => file.path === forgeArgsPath(prepared.runtime)),
          'Forge startup must consume the exact installer-proven argument file',
        );
      // EULA acceptance applies only to this provenance-verified test server.
      await adapter.writeFile(defined(asset.identifier), 'eula.txt', 'eula=true\n');
      let consoleText = '';
      consoleRelay = await adapter.relayConsole(defined(asset.identifier), {
        authorize: async () => {
          await prove(asset);
          return true;
        },
        maxDurationMs: 900000,
        onEvent: (value) => {
          if (value.type === 'console')
            consoleText = `${consoleText}${value.data}\n`.slice(-1048576);
        },
      });
      await consoleRelay.requestLogs();
      await stage('bootstrap.server.start');
      await operation(asset.managedServerId, { action: 'start' });
      // This shape is used only as a backend SLP probe target; it is NEVER published as a Gateway route.
      const probeRoute = {
        backend: { address: pin.backendAddress ?? pin.address, port: pin.port },
        public: { transport: 'tcp' },
        protocol: { gameVersion: prepared.runtime.release },
      } as GatewayRoute;
      await stage('bootstrap.server.readiness');
      const observed = await ready(asset, probeRoute, prepared);
      assert.equal(observed.playerCount, 0, 'Missing player count is not idle evidence');
      await consoleRelay.requestLogs();
      await delay(1000);
      const java = /(?:openjdk|java) version "(\d+)(?:[."][^\n]*)?/.exec(consoleText);
      assert(java, 'Actual java -version output absent; retain server for inspection');
      assert.equal(Number(java[1]), prepared.runtime.javaMajor);
      const imageDigest = defined(await observer.imageIdentity?.(defined(asset.uuid)));
      // Only output observed after this command can corroborate this save.
      consoleText = '';
      await adapter.sendCommand(defined(asset.identifier), 'save-all flush');
      const saveDeadline = Date.now() + 30000;
      while (!/Saved the (?:game|world)/i.test(consoleText) && Date.now() < saveDeadline)
        await delay(500);
      assert(/Saved the (?:game|world)/i.test(consoleText), 'No real save confirmation observed');
      await stage('bootstrap.installation.capture-after-readiness');
      const installed = await captureMinecraftInstallation(captureOptions);
      const installedFiles = promoteMinecraftInstallationEvidence(
        prestart.installedFiles,
        installed.installedFiles,
      );
      assert.equal(installed.artifactSha256, prestart.artifactSha256);
      const installationEvidence = {
        prestart,
        installed,
        java: java[0],
        imageDigest,
        observed,
        consoleSha256: digest(consoleText),
      };
      const checks = Object.fromEntries(
        minecraftVerificationChecks.map((name) => [
          name,
          ['installation', 'status', 'readiness'].includes(name),
        ]),
      );
      await stage('bootstrap.evidence.sign');
      const report = minecraftEvidenceSchema.parse({
        runId: randomUUID(),
        kind: 'installation-bootstrap',
        combinationDigest: minecraftDigest(choice.combination),
        choiceDigest: choice.row.identity_digest,
        mappingDigest: choice.mappingDigest,
        recordedAt: new Date().toISOString(),
        server: {
          uuid: asset.uuid,
          externalId: asset.externalId,
          artifactSha256: installed.artifactSha256,
          imageDigest,
          javaMajor: Number(java[1]),
          installedFiles,
          supportedProperties: installed.supportedProperties,
          worldDataVersion: installed.worldDataVersion,
        },
        client: {
          implementation: 'NickHosting-SLP-nonce-probe',
          version: execution.head,
          protocolId: prepared.protocol.protocolId,
        },
        checks,
        evidenceSha256: digest(JSON.stringify(installationEvidence)),
      });
      await importMinecraftEvidence(
        db,
        context,
        registered.choiceId,
        { report, signature: signMinecraftEvidence(report, env) },
        env,
      );
      await setMinecraftAvailability(db, context, registered.choiceId, { enabled: true }, env);
      assert.equal(
        (await inspectMinecraftCombination(db, registered.choiceId, env)).support,
        'experimental',
      );
      await event('bootstrap.real-installation-evidence', {
        report,
        installationEvidence,
        authenticatedClientVerified: false,
        normalM4CreationVerified: false,
      });
      consoleRelay.close();
      consoleRelay = undefined;
      await remove(asset);
      scenario.completedBootstrap.push(options.profile);
    } else {
      assert(
        scenario.completedBootstrap.includes(options.profile),
        'Real bootstrap evidence is required',
      );
      assert(!scenario.completedMinecraft.includes(options.profile), 'Scenario already completed');
      await stage('minecraft.server.create');
      const asset = await create(registered.mappingId, {
        choiceId: registered.choiceId,
        configuration: { eula: true },
      });
      assert(
        (
          await db
            .selectFrom('minecraft_server_profiles')
            .select('installed')
            .where('server_id', '=', asset.managedServerId)
            .executeTakeFirstOrThrow()
        ).installed,
      );
      const fixtureName = `M4${randomBytes(5).toString('hex')}`;
      const offlineBytes = createHash('md5').update(`OfflinePlayer:${fixtureName}`).digest();
      offlineBytes[6] = ((offlineBytes[6] ?? 0) & 0x0f) | 0x30;
      offlineBytes[8] = ((offlineBytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = offlineBytes.toString('hex');
      const offlineUuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      // Fixture-only configuration, explicitly separated from protected product properties.
      // It permits this independent offline protocol client without fake Gateway authentication.
      const fixtureProperties = [
        'online-mode=false',
        'enforce-secure-profile=false',
        'white-list=true',
        'enforce-whitelist=true',
        'view-distance=2',
        'simulation-distance=2',
        'max-players=4',
        '',
      ].join('\n');
      await adapter.writeFile(defined(asset.identifier), 'server.properties', fixtureProperties);
      await adapter.writeFile(
        defined(asset.identifier),
        'whitelist.json',
        JSON.stringify([{ uuid: offlineUuid, name: fixtureName }]),
      );
      await event('minecraft.offline-client-fixture-configured', {
        uuid: asset.uuid,
        propertiesSha256: digest(fixtureProperties),
        onlineAuthenticationVerified: false,
      });
      // Establish first real running reachability before allowing any sleeping listener.
      await operation(asset.managedServerId, { action: 'start' });
      const policy = {
        enabled: true,
        protocolId: 'minecraft-java',
        gameVersion: prepared.runtime.release,
        idleTimeoutSeconds: null,
        readinessTimeoutSeconds: 600,
        readinessMaxAgeSeconds: 15,
        estimateMaxAgeSeconds: 86400,
        wakeRetrySeconds: 5,
        mode: 'auto',
      };
      const initialPolicy = await setGatewayPolicy(db, context, asset.managedServerId, policy, {
        env,
      });
      const allocation = await db
        .selectFrom('server_allocations')
        .selectAll()
        .where('server_id', '=', asset.managedServerId)
        .executeTakeFirstOrThrow();
      await setGatewayRoute(
        db,
        context,
        {
          serverId: asset.managedServerId,
          allocationId: allocation.id,
          publicAddress: plan.gatewayAddress,
          publicPort: pin.port,
          transport: 'tcp',
        },
        env,
      );
      const api = createApp({
        database,
        codec,
        env,
        origins: [],
        identity: async () => {
          throw new DomainError('forbidden');
        },
        management: async () => runtime,
      });
      gateway = await createGatewayRuntime(env, {
        protocols: [createMinecraftGatewayModuleAdapter()],
        // Actual authenticated HTTP route handlers, in process: no additional host listener.
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          const response = await api.fetch(request);
          if (!response.ok) {
            const action = new URL(request.url).pathname.split('/').at(-1);
            await event('gateway.control-http-failure', {
              action: action && /^[a-z-]{1,64}$/.test(action) ? action : 'unknown',
              status: response.status,
            });
          }
          return response;
        },
      });
      const until = async (
        predicate: () => Promise<boolean>,
        label: string,
        timeoutMs = 600000,
      ) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await runtime.refreshObservations();
          await reconcileGatewayState(db, asset.managedServerId, { env });
          if (await predicate()) return;
          await delay(1000);
        }
        throw new Error(`Live scenario deadline: ${label}`);
      };
      const waitCurrentRoute = async (
        generation: string,
        label: string,
        mode: GatewayRoute['mode'] = 'online',
      ) => {
        let matched: GatewayRoute | undefined;
        await until(async () => {
          const state = await getGatewayState(db, asset.managedServerId, { env });
          assert.equal(
            state.generation,
            generation,
            'Live route wait lost its pinned consent generation',
          );
          const snapshot = await getGatewaySnapshot(db, env);
          matched = minecraftLiveReadyRoute(
            state,
            snapshot,
            defined(gateway).gateway.health(),
            asset.managedServerId,
            generation,
            Date.now(),
            mode,
          );
          return matched !== undefined;
        }, label);
        return defined(matched);
      };
      await stage('minecraft.gateway.initial-ready');
      asset.route = await waitCurrentRoute(initialPolicy.generation, 'initial actual readiness');
      await save();
      await event('minecraft.core-created-and-real-ready', { uuid: asset.uuid });
      // Leave enough real time for inventory validation and a protocol login. This
      // changes only the fixture's idle policy; Gateway lease/safety fences are unchanged.
      const idleTimeoutSeconds = 30;
      const idlePolicy = await setGatewayPolicy(
        db,
        context,
        asset.managedServerId,
        { ...policy, idleTimeoutSeconds },
        { env },
      );
      await stage('minecraft.client.wait-current-route');
      asset.route = await waitCurrentRoute(
        idlePolicy.generation,
        'current generation before client',
      );
      await event('minecraft.client-current-generation-ready', {
        generation: asset.route.generation,
        routeRevision: asset.route.revision,
        gatewayHealth: defined(gateway).gateway.health(),
        idleTimeoutSeconds,
      });
      await stage('minecraft.client.join');
      const initialJoin = await independentClient(
        plan.gatewayAddress,
        pin.port,
        prepared.runtime.release,
        fixtureName,
        'play',
      );
      joinedClient = initialJoin.client;
      joinedProtocol = initialJoin.protocol;
      assert.equal(joinedProtocol.release, prepared.runtime.release);
      assert.equal(joinedProtocol.protocolId, prepared.protocol.protocolId);
      const actualOnlineRoute = defined(
        (await getGatewaySnapshot(db, env)).routes.find(
          (route) => route.serverId === asset.managedServerId,
        ),
      );
      await until(
        async () =>
          (
            await probeMinecraftStatus(
              { route: actualOnlineRoute, signal: AbortSignal.timeout(5000) },
              prepared.protocol,
            )
          ).playerCount === 1,
        'independent real player count',
      );
      await stage('minecraft.client.nonidle-hold');
      const presenceStarted = performance.now();
      const requiredPresenceMs = idleTimeoutSeconds * 1000 + 5000;
      while (performance.now() - presenceStarted < requiredPresenceMs) {
        if (joinedClient.ended)
          throw new MinecraftLiveClientFailure('ended_after_play', 'play', 'play');
        const state = await getGatewayState(db, asset.managedServerId, { env });
        assert.equal(state.state, 'online');
        assert.equal(state.sleepJobId, null);
        await delay(1000);
      }
      if (joinedClient.ended)
        throw new MinecraftLiveClientFailure('ended_after_play', 'play', 'play');
      assert.equal(
        (
          await probeMinecraftStatus(
            { route: actualOnlineRoute, signal: AbortSignal.timeout(5000) },
            prepared.protocol,
          )
        ).playerCount,
        1,
      );

      await event('minecraft.independent-client-transparent-play-and-nonidle', {
        implementation: 'minecraft-protocol 1.68.0 offline fixture',
        idleTimeoutSeconds,
        positiveClientDurationMs: performance.now() - presenceStarted,
        release: joinedProtocol.release,
        protocolId: joinedProtocol.protocolId,
        protocolEvidenceSource: joinedProtocol.source,
        onlineAuthenticationVerified: false,
      });
      joinedClient.end();
      joinedClient = undefined;
      await until(
        async () => !!(await getGatewayState(db, asset.managedServerId, { env })).sleepJobId,
        'empty server idle operation',
      );
      let state = await getGatewayState(db, asset.managedServerId, { env });
      await pump(defined(state.sleepJobId));
      await stage('minecraft.gateway.sleeping');
      await waitCurrentRoute(state.generation, 'confirmed sleep snapshot', 'sleeping');
      const startsBefore = await db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', asset.managedServerId)
        .where('action', '=', 'start')
        .execute();
      for (let i = 0; i < 3; i++) {
        await waitCurrentRoute(state.generation, 'sleeping before passive status', 'sleeping');
        const status = await ping({
          host: plan.gatewayAddress,
          port: pin.port,
          version: prepared.runtime.release,
          closeTimeout: 5000,
        });
        assert(
          typeof status.version === 'object' &&
            status.version.protocol === prepared.protocol.protocolId,
        );
        assert('description' in status && JSON.stringify(status.description).includes('sleeping'));
      }
      await delay(1000);
      assert.equal((await getGatewayState(db, asset.managedServerId, { env })).state, 'sleeping');
      assert.equal(
        (
          await db
            .selectFrom('server_operations')
            .select('job_id')
            .where('server_id', '=', asset.managedServerId)
            .where('action', '=', 'start')
            .execute()
        ).length,
        startsBefore.length,
      );
      await event('minecraft.passive-status-never-wakes');
      await waitCurrentRoute(state.generation, 'sleeping before burst joins', 'sleeping');
      await stage('minecraft.client.wake-burst');
      const joins = await Promise.all(
        Array.from({ length: 12 }, () =>
          independentClient(
            plan.gatewayAddress,
            pin.port,
            prepared.runtime.release,
            fixtureName,
            'disconnect',
          ),
        ),
      );
      assert(joins.every((result) => result.disconnect?.includes('starting')));
      state = await getGatewayState(db, asset.managedServerId, { env });
      assert.equal(state.state, 'waking');
      const startsAfter = await db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', asset.managedServerId)
        .where('action', '=', 'start')
        .execute();
      assert.equal(startsAfter.length, startsBefore.length + 1);
      await pump(defined(state.wakeJobId));
      await waitCurrentRoute(state.generation, 'wake actual readiness snapshot');
      await stage('minecraft.client.post-wake-join');
      const postWakeJoin = await independentClient(
        plan.gatewayAddress,
        pin.port,
        prepared.runtime.release,
        fixtureName,
        'play',
      );
      joinedClient = postWakeJoin.client;
      postWakeProtocol = postWakeJoin.protocol;
      assert.equal(postWakeProtocol.protocolId, prepared.protocol.protocolId);
      assert.deepEqual(postWakeProtocol, joinedProtocol);
      joinedClient.end();
      joinedClient = undefined;
      await event('minecraft.burst-joins-single-wake', {
        attempts: joins.length,
        wakeJobId: state.wakeJobId,
        independentPostWakePlayVerified: true,
        protocol: postWakeProtocol,
      });
      const startupSamples = await db
        .selectFrom('gateway_startup_samples')
        .selectAll()
        .where('server_id', '=', asset.managedServerId)
        .execute();
      assert(
        startupSamples.some(
          (sample) => sample.job_id === state.wakeJobId && sample.duration_ms > 0,
        ),
      );
      if (startupSamples.length < 5)
        assert.equal(
          (await getGatewayState(db, asset.managedServerId, { env })).startupEstimate,
          null,
        );
      await event('minecraft.real-startup-measurements', {
        samples: startupSamples,
        estimate: (await getGatewayState(db, asset.managedServerId, { env })).startupEstimate,
      });
      const manualPolicy = await setGatewayPolicy(db, context, asset.managedServerId, policy, {
        env,
      });
      await waitCurrentRoute(manualPolicy.generation, 'current snapshot before manual save');
      const actualImageDigest = defined(await observer.imageIdentity?.(defined(asset.uuid)));
      let saveOutput = '';
      consoleRelay = await adapter.relayConsole(defined(asset.identifier), {
        authorize: async () => {
          await prove(asset);
          return true;
        },
        maxDurationMs: 120000,
        onEvent: (value) => {
          if (value.type === 'console') saveOutput = `${saveOutput}${value.data}\n`.slice(-1048576);
        },
      });
      await adapter.sendCommand(defined(asset.identifier), 'save-all flush');
      const saveDeadline = Date.now() + 30000;
      while (!/Saved the (?:game|world)/i.test(saveOutput) && Date.now() < saveDeadline)
        await delay(500);
      assert(
        /Saved the (?:game|world)/i.test(saveOutput),
        'Actual Minecraft save flush did not confirm',
      );
      await operation(asset.managedServerId, { action: 'stop' });
      const savedWorld = inspectMinecraftLevelDat(
        await adapter.readFile(defined(asset.identifier), 'world/level.dat'),
        { release: prepared.runtime.release },
      );
      consoleRelay.close();
      consoleRelay = undefined;
      await event('minecraft.flush-and-confirmed-stop', {
        world: savedWorld,
        consoleSha256: digest(saveOutput),
      });
      await stage('minecraft.client.manual-stop');
      // A manual stop revokes the earlier policy's consent and rotates its
      // generation. Pin the confirmed post-stop state, never the pre-stop policy.
      const manuallyStopped = await getGatewayState(db, asset.managedServerId, { env });
      assert.equal(manuallyStopped.state, 'manually_stopped');
      assert.notEqual(manuallyStopped.generation, manualPolicy.generation);
      await event('minecraft.manual-stop-consent-revoked', {
        previousGeneration: manualPolicy.generation,
        generation: manuallyStopped.generation,
      });
      await waitCurrentRoute(
        manuallyStopped.generation,
        'manual stop snapshot',
        'manually_stopped',
      );
      const manualReply = await independentClient(
        plan.gatewayAddress,
        pin.port,
        prepared.runtime.release,
        fixtureName,
        'disconnect',
      );
      assert(manualReply.disconnect?.includes('Server stopped'));
      const afterManualJoin = await getGatewayState(db, asset.managedServerId, { env });
      assert.equal(afterManualJoin.state, 'manually_stopped');
      assert.equal(afterManualJoin.generation, manuallyStopped.generation);
      await event('minecraft.manual-stop-suppresses-wake', {
        generation: afterManualJoin.generation,
      });
      const host = await db
        .selectFrom('physical_hosts')
        .selectAll()
        .where('id', '=', scenario.hostId)
        .executeTakeFirstOrThrow();
      const hostPolicy = {
        id: host.id,
        name: host.name,
        memoryLimitMiB: host.memory_limit_mib,
        cpuLimitPercent: host.cpu_limit_percent,
        storagePoolMiB: Number(host.storage_pool_mib),
        memoryHeadroomMiB: host.memory_headroom_mib,
        cpuHeadroomPercent: host.cpu_headroom_percent,
        diskHeadroomMiB: Number(host.disk_headroom_mib),
        localDiskPath: host.local_disk_path,
        observerId: host.observer_id,
        uploadPolicy: host.upload_policy,
      };
      // Owner settings in the isolated schema constrain physical capacity; no host workload or
      // production limits are changed to manufacture memory pressure.
      await setPhysicalHost(db, context, {
        ...hostPolicy,
        memoryHeadroomMiB: host.memory_limit_mib - 256,
      });
      const denialPolicy = await setGatewayPolicy(db, context, asset.managedServerId, policy, {
        env,
      });
      await stage('minecraft.client.resource-denial');
      await waitCurrentRoute(
        denialPolicy.generation,
        'sleeping before resource refusal',
        'sleeping',
      );
      const beforeDenied = await db
        .selectFrom('server_operations')
        .select('job_id')
        .where('server_id', '=', asset.managedServerId)
        .where('action', '=', 'start')
        .execute();
      const denialStarted = performance.now();
      const denied = await independentClient(
        plan.gatewayAddress,
        pin.port,
        prepared.runtime.release,
        fixtureName,
        'disconnect',
      );
      const denialMs = performance.now() - denialStarted;
      assert(denied.disconnect?.includes('cannot start'));
      const blocked = await getGatewayState(db, asset.managedServerId, { env });
      assert.equal(blocked.state, 'blocked');
      assert.equal(blocked.generation, denialPolicy.generation);
      assert.equal(blocked.errorCode, 'resources_unavailable');
      assert(denialMs < 5000, 'Admission refusal must be immediate, without a waiting queue');
      await waitCurrentRoute(denialPolicy.generation, 'blocked before repeat join', 'blocked');
      const blockedReply = await independentClient(
        plan.gatewayAddress,
        pin.port,
        prepared.runtime.release,
        fixtureName,
        'disconnect',
      );
      assert(blockedReply.disconnect?.includes('cannot start'));
      assert.equal(
        (
          await db
            .selectFrom('server_operations')
            .select('job_id')
            .where('server_id', '=', asset.managedServerId)
            .where('action', '=', 'start')
            .execute()
        ).length,
        beforeDenied.length,
      );
      assert.equal(
        (
          await db
            .selectFrom('resource_reservations')
            .select('server_id')
            .where('server_id', '=', asset.managedServerId)
            .execute()
        ).length,
        0,
      );
      await setPhysicalHost(db, context, hostPolicy);
      await event('minecraft.immediate-physical-policy-denial', {
        denialMs,
        queuedStarts: 0,
        actualHostPressureInduced: false,
      });
      await gateway.close();
      gateway = undefined;
      await event('minecraft.partial-live-checks-complete', {
        independentOfflineClientVerified: true,
        authenticatedOnlineClientVerified: false,
        contentWorldOperationsVerified: false,
        resourceDenialVerified: true,
        support: (await inspectMinecraftCombination(db, registered.choiceId, env)).support,
      });
      await options.afterProtocol?.({
        db,
        context,
        env,
        runtime,
        adapter,
        asset,
        choiceId: registered.choiceId,
        prepared,
        ledger,
        pump,
        operation,
        event,
        prove,
      });
      if (options.afterProtocol) {
        // No unchecked capability is promoted: every named check above used the real
        // server/Gateway and independent client, and the separately reviewed content hook passed.
        await stage('minecraft.real-evidence.sign');
        const choice = await inspectMinecraftCombination(db, registered.choiceId, env);
        const bootstrap = choice.evidence.find(
          (report) => report.kind === 'installation-bootstrap' && report.server,
        );
        assert(bootstrap?.server && bootstrap.server.imageDigest === actualImageDigest);
        const profile = await db
          .selectFrom('minecraft_server_profiles')
          .selectAll()
          .where('server_id', '=', asset.managedServerId)
          .executeTakeFirstOrThrow();
        assert(profile.installed);
        const installed = await captureMinecraftInstallation({
          adapter,
          identifier: defined(asset.identifier),
          runtime: prepared.runtime,
          binding: choice.row.binding as MinecraftRuntimeMapping,
          assertOwned: async () => {
            await prove(asset);
          },
          workDirectory: resolve('mountdata/test-assets'),
          userAgent: plan.metadataUserAgent,
        });
        const installedFiles = promoteMinecraftInstallationEvidence(
          bootstrap.server.installedFiles,
          installed.installedFiles,
        );
        const evidence = {
          testedServerUuid: asset.uuid,
          offlineClient: true,
          authenticatedOnlineClientVerified: false,
          startupSamples,
          savedWorld,
          bootstrapRunId: bootstrap.runId,
          installed,
          clientHandshakes: {
            initial: defined(joinedProtocol),
            postWake: defined(postWakeProtocol),
          },
          eventReceipt: minecraftDigest(ledger.events),
        };
        const report = minecraftEvidenceSchema.parse({
          runId: randomUUID(),
          kind: 'real-server',
          combinationDigest: minecraftDigest(choice.combination),
          choiceDigest: choice.row.identity_digest,
          mappingDigest: choice.mappingDigest,
          recordedAt: new Date().toISOString(),
          server: {
            ...bootstrap.server,
            uuid: asset.uuid,
            externalId: asset.externalId,
            imageDigest: actualImageDigest,
            artifactSha256: installed.artifactSha256,
            installedFiles,
            supportedProperties: installed.supportedProperties,
            worldDataVersion: installed.worldDataVersion,
          },
          client: {
            implementation: 'minecraft-protocol-offline-fixture',
            version: '1.68.0',
            protocolId: defined(joinedProtocol).protocolId,
          },
          checks: Object.fromEntries(minecraftVerificationChecks.map((name) => [name, true])),
          evidenceSha256: minecraftDigest(evidence),
        });
        await importMinecraftEvidence(
          db,
          context,
          registered.choiceId,
          { report, signature: signMinecraftEvidence(report, env) },
          env,
        );
        assert.equal(
          (await inspectMinecraftCombination(db, registered.choiceId, env)).support,
          'verified',
        );
        await event('minecraft.real-combination-evidence', {
          report,
          evidence,
          rollout: 'private-testing',
        });
      }
      await remove(asset);
      scenario.completedMinecraft.push(options.profile);
    }
    delete scenario.activePhase;
    await save();
    return {
      ledgerPath: path,
      phase: options.phase,
      support: (await inspectMinecraftCombination(db, registered.choiceId, env)).support,
    };
  } catch (error) {
    scenario.failedAt ??= new Date().toISOString();
    await event('scenario.failed-preserve-for-review', {
      phase: scenario.activePhase,
      stage: scenario.stage,
      errorCode: error instanceof DomainError ? error.code : 'validation_failed',
      ...(error instanceof MinecraftLiveClientFailure
        ? {
            clientFailure: {
              category: error.category,
              expected: error.expected,
              state: error.clientState,
            },
          }
        : {}),
      ...(gateway
        ? { gatewayHealth: gateway.gateway.health(), gatewayMetrics: gateway.gateway.metrics() }
        : {}),
      // Frames only: never serialize raw upstream error bodies, URLs, tokens or assertion values.
      stack:
        error instanceof Error
          ? error.stack
              ?.split('\n')
              .slice(1)
              .filter((line) => /(?:scripts|packages|apps|games)\/[^\s]+\.ts:\d+:\d+/.test(line))
              .slice(0, 12)
              .map((line) => line.replaceAll(process.cwd(), '<project>'))
          : [],
    });
    throw error;
  } finally {
    joinedClient?.end();
    consoleRelay?.close();
    await gateway?.close();
    // Close connections only. Evidence schema and owned remote assets survive any failed step.
    await db.destroy();
  }
}

async function main() {
  const args = process.argv.slice(2),
    option = (name: string) => args[args.indexOf(name) + 1];
  const phase = option('--phase'),
    profile = option('--profile');
  assert(phase === 'bootstrap' || phase === 'minecraft' || phase === 'cleanup');
  assert(profile && minecraftManifest.runtimes.some((runtime) => runtime.id === profile));
  const result = await runMinecraftLiveScenario({
    planPath: defined(option('--plan')),
    phase,
    profile: profile as Profile,
    ownerApproved: args.includes('--owner-approved'),
    retainSchema: args.includes('--retain-schema'),
    ...(args.includes('--ledger') ? { ledgerPath: defined(option('--ledger')) } : {}),
    ...(args.includes('--content')
      ? { afterProtocol: (await import('./m4-live-content.js')).checkMinecraftLiveContent }
      : {}),
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      'M4 live scenario stopped. Inspect the protected ledger; no automatic cleanup was attempted.',
    );
    process.exitCode = 1;
  });
