import { DomainError } from '@nickhosting/core';
import {
  type MinecraftEvidence,
  minecraftDigest,
  minecraftRuntimeMappingSchema,
  type ResolvedMinecraftRuntime,
  validateMinecraftRuntimeMapping,
} from '@nickhosting/minecraft';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { DB, Environment } from './admission.js';
import {
  assertMinecraftDeclaredEnvironment,
  inspectMinecraftCombination,
} from './minecraft-registry.js';

type MinecraftChoice = Awaited<ReturnType<typeof inspectMinecraftCombination>>;

/** Exactly the environment created by the immutable mapping, including owned multiport roles. */
export async function minecraftProvisionEnvironment(
  db: DB,
  serverId: string,
  choice: MinecraftChoice,
) {
  const binding = minecraftRuntimeMappingSchema.parse(choice.row.binding);
  const environment = {
    ...choice.mapping.environment,
    ...validateMinecraftRuntimeMapping(
      choice.row.resolved_runtime as ResolvedMinecraftRuntime,
      binding,
    ),
  };
  const allocations = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  for (const role of choice.mapping.port_roles) {
    if (!role.environmentVariable) continue;
    const allocation = allocations.find((item) => item.role === role.role);
    if (!allocation) throw new DomainError('provenance_mismatch');
    environment[role.environmentVariable] = String(allocation.port);
  }
  assertMinecraftDeclaredEnvironment(
    binding.declaredEggVariables,
    binding.declaredEggVariables,
    environment,
  );
  return environment;
}
export async function assertMinecraftEggEnvironment(
  adapter: Pick<PterodactylAdapter, 'getEgg'>,
  choice: MinecraftChoice,
  environment: Record<string, string>,
): Promise<void> {
  const binding = minecraftRuntimeMappingSchema.parse(choice.row.binding);
  const egg = await adapter.getEgg(choice.mapping.nest_id, choice.mapping.egg_id);
  if (
    egg.id !== choice.mapping.egg_id ||
    egg.nest !== choice.mapping.nest_id ||
    !egg.relationships?.variables
  )
    throw new DomainError('configuration_invalid');
  assertMinecraftDeclaredEnvironment(
    binding.declaredEggVariables,
    egg.relationships.variables.data.map((item) => item.attributes.env_variable),
    environment,
  );
}

const jvmEnvironment = [
  'JDK_JAVA_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'CLASSPATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'JAVA_HOME',
  'JRE_HOME',
  'BASH_ENV',
  'ENV',
  'IFS',
  'CDPATH',
  'SHELLOPTS',
  'BASHOPTS',
  'GLOBIGNORE',
  'IBM_JAVA_OPTIONS',
  'OPENJ9_JAVA_OPTIONS',
] as const;
function launchEnvironmentKeys(environment: Record<string, unknown>): string[] {
  return [
    ...new Set([
      ...jvmEnvironment,
      ...Object.keys(environment).filter((key) => key.startsWith('LD_')),
    ]),
  ];
}

/** Supported Fabric launch shape, not an arbitrary shell/JVM parser. The verified
 * launcher and its Mojang target must remain authoritative. Unsupported commands
 * require a new evidence-backed integration contract rather than a checkbox. */
export function assertMinecraftJavaLaunch(
  startup: string,
  environment: Record<string, string>,
  target: { kind: 'jar'; path: string } | { kind: 'forge'; paths: readonly string[] },
): void {
  if (
    launchEnvironmentKeys(environment).some((name) => Boolean(environment[name])) ||
    /[\r\n\0"'`$;&|<>\\]/.test(startup)
  )
    throw new DomainError('configuration_invalid');
  const expanded = startup.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, name: string) => {
    if (environment[name] === undefined || !/^[A-Za-z0-9._/:=+,-]+$/.test(environment[name]))
      throw new DomainError('configuration_invalid');
    return environment[name];
  });
  const tokens = expanded.trim().split(/[ \t]+/);
  const jar =
    target.kind === 'jar'
      ? tokens.indexOf('-jar')
      : tokens.findIndex((token) => token.startsWith('@'));
  const end = target.kind === 'jar' ? jar + 2 : jar + 1;
  if (
    tokens[0] !== 'java' ||
    jar < 1 ||
    (target.kind === 'jar'
      ? tokens[jar + 1] !== target.path
      : !target.paths.includes(tokens[jar]?.slice(1) ?? '')) ||
    !tokens.slice(end).every((token) => token === 'nogui' || token === '--nogui')
  )
    throw new DomainError('configuration_invalid');
  for (const token of tokens.slice(1, jar)) {
    // Exact harmless property names avoid Java/Fabric bootstrapping, alternate
    // class loaders, agent injection and property-based game target overrides.
    if (
      !/^(?:-Xm[sx][0-9]+[kKmMgG]?|-XX:(?:[+-](?:UseG1GC|UseZGC|UseShenandoahGC|UseParallelGC|UseSerialGC|ParallelRefProcEnabled|DisableExplicitGC|AlwaysPreTouch|UseStringDeduplication|PerfDisableSharedMem|UnlockExperimentalVMOptions)|(?:MaxGCPauseMillis|G1HeapRegionSize|G1NewSizePercent|G1MaxNewSizePercent|G1ReservePercent|G1HeapWastePercent|G1MixedGCCountTarget|InitiatingHeapOccupancyPercent|G1MixedGCLiveThresholdPercent|G1RSetUpdatingPauseTimePercent|SurvivorRatio|MaxTenuringThreshold|ParallelGCThreads|ConcGCThreads|MaxRAMPercentage|InitialRAMPercentage)=[0-9]+(?:\.[0-9]+)?[kKmMgG]?)|-Dterminal\.(?:jline|ansi)=(?:true|false)|-Dfile\.encoding=UTF-8|-Djava\.awt\.headless=(?:true|false))$/.test(
        token,
      )
    )
      throw new DomainError('configuration_invalid');
  }
}
export function assertMinecraftFabricLaunch(
  startup: string,
  environment: Record<string, string>,
  launcher: string,
): void {
  assertMinecraftJavaLaunch(startup, environment, { kind: 'jar', path: launcher });
}
export function assertMinecraftVerifiedLaunch(
  startup: string,
  environment: Record<string, string>,
  profile: string,
  launcher: string | undefined,
  report: MinecraftEvidence,
): void {
  if (profile === 'forge') {
    const paths =
      report.server?.installedFiles
        ?.map((file) => file.path)
        .filter((path) =>
          /^libraries\/net\/minecraftforge\/forge\/[^/]+\/unix_args\.txt$/.test(path),
        ) ?? [];
    if (paths.length !== 1) throw new DomainError('configuration_invalid');
    assertMinecraftJavaLaunch(startup, environment, { kind: 'forge', paths });
  } else {
    if (!launcher) throw new DomainError('configuration_invalid');
    assertMinecraftJavaLaunch(startup, environment, { kind: 'jar', path: launcher });
  }
}

/** Provider configuration can drift independently of the immutable local mapping. */
export async function assertMinecraftRemoteLaunch(
  db: DB,
  serverId: string,
  remote: ApplicationServer,
  env: Environment,
  adapter: Pick<PterodactylAdapter, 'getEgg'>,
): Promise<void> {
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
  const binding = minecraftRuntimeMappingSchema.parse(choice.row.binding);
  const expected = await minecraftProvisionEnvironment(db, serverId, choice);
  await assertMinecraftEggEnvironment(adapter, choice, expected);
  const actual = remote.container.environment;
  if (
    choice.mappingDigest !== choice.row.mapping_digest ||
    remote.egg !== choice.mapping.egg_id ||
    remote.container.image !== binding.image ||
    remote.container.startup_command !== choice.mapping.startup ||
    !actual ||
    Object.entries(expected).some(
      ([key, value]) =>
        actual[key] === null || actual[key] === undefined || String(actual[key]) !== value,
    )
  )
    throw new DomainError('provenance_mismatch');
  if (actual.STARTUP !== undefined && actual.STARTUP !== choice.mapping.startup)
    throw new DomainError('provenance_mismatch');
  // These variables affect Java even when absent from the startup template. A
  // provider-added injection must never inherit trust from an image digest.
  for (const name of launchEnvironmentKeys(actual))
    if (String(actual[name] ?? '') !== (expected[name] ?? ''))
      throw new DomainError('provenance_mismatch');
  const primary = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', serverId)
    .where('is_primary', '=', true)
    .executeTakeFirstOrThrow();
  const launch: Record<string, string> = {
    ...expected,
    SERVER_MEMORY: String(remote.limits.memory),
    SERVER_IP: primary.address,
    SERVER_PORT: String(primary.port),
    P_SERVER_UUID: remote.uuid,
    // Panel 1.11.x config/pterodactyl.php derives this environment field from
    // allocation_limit; it is provider metadata, never an egg/JVM default.
    P_SERVER_ALLOCATION_LIMIT: String(choice.mapping.feature_limits.allocations),
  };
  const providerFields = new Set([
    'STARTUP',
    'P_SERVER_LOCATION',
    'P_SERVER_UUID',
    'P_SERVER_ALLOCATION_LIMIT',
    'SERVER_MEMORY',
    'SERVER_IP',
    'SERVER_PORT',
  ]);
  if (Object.keys(actual).some((key) => !Object.hasOwn(expected, key) && !providerFields.has(key)))
    throw new DomainError('provenance_mismatch');
  for (const name of [
    'P_SERVER_UUID',
    'P_SERVER_ALLOCATION_LIMIT',
    'SERVER_MEMORY',
    'SERVER_IP',
    'SERVER_PORT',
  ])
    if (actual[name] !== undefined && String(actual[name]) !== launch[name])
      throw new DomainError('provenance_mismatch');
  if (
    actual.P_SERVER_ALLOCATION_LIMIT !== undefined &&
    remote.feature_limits.allocations !== choice.mapping.feature_limits.allocations
  )
    throw new DomainError('provenance_mismatch');
  for (const [, name] of choice.mapping.startup.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
    if (name && !(name in launch)) throw new DomainError('configuration_invalid');
    if (name && actual[name] !== undefined && String(actual[name]) !== launch[name])
      throw new DomainError('provenance_mismatch');
  }
  const evidence = await requireMinecraftRuntimeImageEvidence(db, serverId, null, env);
  assertMinecraftVerifiedLaunch(
    choice.mapping.startup,
    launch,
    binding.profile,
    binding.artifactPaths.server,
    evidence.report,
  );
}

/** Docker configuration content identity (.Image), NOT a registry manifest digest.
 * An absent server container is explicitly unobserved: verified artifact/config
 * installation may precede an admitted first start, but playable readiness cannot.
 * The hash alone proves neither the Java version nor protocol support; the signed
 * exact-combination real-server report provides that separate test evidence. */
export async function requireMinecraftRuntimeImageEvidence(
  db: DB,
  serverId: string,
  observed: string | null,
  env: Environment = {},
): Promise<{
  expected: string;
  observed: string | null;
  verified: boolean;
  report: MinecraftEvidence;
}> {
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!server || !profile) throw new DomainError('not_found');
  const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
  if (
    choice.row.mapping_id !== server.mapping_id ||
    choice.mapping.game_id !== 'minecraft-java' ||
    choice.mapping.runtime_id !== choice.combination.profile ||
    choice.row.mapping_digest !== choice.mappingDigest
  )
    throw new DomainError('provenance_mismatch');
  if (choice.support !== 'verified') {
    const rollout = await db
      .selectFrom('game_rollouts')
      .selectAll()
      .where('integration_id', '=', 'minecraft-java')
      .executeTakeFirst();
    const owner = await db
      .selectFrom('user')
      .select(['id', 'role'])
      .where('id', '=', server.owner_id)
      .executeTakeFirst();
    if (
      choice.support !== 'experimental' ||
      rollout?.state !== 'private-testing' ||
      !owner ||
      (owner.role !== 'owner' && !rollout.allowlist.includes(owner.id))
    )
      throw new DomainError('integration_unavailable');
  }
  const now = Date.now();
  const reports = choice.evidence
    .filter(
      (report) =>
        (report.kind === 'real-server' || report.kind === 'installation-bootstrap') &&
        report.combinationDigest === minecraftDigest(choice.combination) &&
        report.mappingDigest === choice.mappingDigest &&
        report.choiceDigest === choice.row.identity_digest &&
        Date.parse(report.recordedAt) <= now &&
        now - Date.parse(report.recordedAt) < 180 * 86400000,
    )
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  const report = reports[0];
  if (
    !report?.server ||
    !report.checks.installation ||
    report.server.javaMajor !== choice.combination.javaMajor ||
    (reports[1] && Date.parse(reports[1].recordedAt) === Date.parse(report.recordedAt))
  )
    throw new DomainError('integration_unavailable');
  if (
    observed !== null &&
    (!/^sha256:[a-f0-9]{64}$/.test(observed) || observed !== report.server.imageDigest)
  )
    throw new DomainError('provenance_mismatch');
  return { expected: report.server.imageDigest, observed, verified: observed !== null, report };
}
