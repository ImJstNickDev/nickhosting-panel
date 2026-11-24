import { type AuthContext, DomainError } from '@nickhosting/core';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import { sql } from 'kysely';
import { OpenworldTokenExpired } from '../../../games/openworld/src/dashboard-api.js';
import type { OpenworldNativeConnection } from '../../../games/openworld/src/native-diagnostics.js';
import { openworldDataRoot } from '../../../games/openworld/src/offline-players.js';
import {
  type ModerationChange,
  type ModerationRequest,
  moderationPlayerName,
} from '../../../games/openworld/src/player-moderation.js';
import {
  confirmModerationTarget,
  playerBans,
  playerMemberships,
  playerRoles,
  proveSavedModerationName,
} from '../../../games/openworld/src/player-moderation-native.js';
import { ruleReplies } from '../../../games/openworld/src/rules-console.js';
import { canChangeOpenworldLegacyRules } from '../../../games/openworld/src/rules-native.js';
import { openworldActionReceipt } from './openworld-action-receipts.js';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  type OpenworldNativeOptions,
  openworldProcessRef,
  readOpenworldScope,
} from './openworld-telemetry.js';

type Grant = 'ban.create' | 'bans.manage' | 'roles.manage' | 'territory.manage';
type WithFiles = <T>(
  who: AuthContext,
  id: string,
  grant: Grant,
  signal: AbortSignal,
  work: (files: FilemanReadService) => Promise<T>,
) => Promise<T>;
const grants = {
  ban: 'ban.create',
  unban: 'bans.manage',
  role: 'roles.manage',
  member: 'territory.manage',
} as const;

async function readMemberships(files: FilemanReadService, account: string) {
  const data = await openworldDataRoot(files, await files.list(''));
  if (!data) throw new DomainError('integration_unavailable');
  const entry = data.entries.find((e) => e.name === 'zones.json');
  if (!entry) return [];
  if (entry.kind !== 'file' || entry.size > 512 * 1024)
    throw new DomainError('integration_unavailable');
  return playerMemberships(
    await files.read({
      path: [data.directory, 'zones.json'].filter(Boolean).join('/'),
      maxBytes: 512 * 1024,
    }),
    account,
  );
}
const readRoles = async (files: FilemanReadService, account: string) =>
  playerRoles(await files.read({ path: 'roles.json', maxBytes: 512 * 1024 }), account);
const canManagePlayerAccounts = (version: string) => version === 'a1.2.9' || version === 'a1.2.10';

export function createOpenworldPlayerModeration(
  options: OpenworldNativeOptions & { withFiles: WithFiles },
) {
  const { db, withFiles, fetcher = fetch } = options;
  const connect = createOpenworldNativeConnection(options);
  async function scopeFor(who: AuthContext, id: string, grant: Grant) {
    return readOpenworldScope(db, id, {
      who,
      resource: 'player-moderation',
      moderationGrant: grant,
    });
  }
  async function read<T>(
    who: AuthContext,
    id: string,
    grant: Grant,
    load: (native: OpenworldNativeConnection) => Promise<T>,
  ) {
    const scope = await scopeFor(who, id, grant);
    if (scope.reason) throw new DomainError('game_not_ready');
    const data = await connect(scope, (origin, token, signal) =>
      load({ origin, token, signal, fetcher }),
    );
    assertCurrentOpenworldScope(scope, await scopeFor(who, id, grant));
    return { data, version: scope.version, processRef: openworldProcessRef(scope) };
  }
  return {
    async bans(who: AuthContext, id: string) {
      const { data: bans, version, processRef } = await read(who, id, 'bans.manage', playerBans);
      return {
        bans,
        processRef,
        mutable: canChangeOpenworldLegacyRules(version),
        onlineBan: canManagePlayerAccounts(version),
      };
    },
    async roles(who: AuthContext, id: string, account: string) {
      const { data, version, processRef } = await read(who, id, 'roles.manage', ({ signal }) =>
        withFiles(who, id, 'roles.manage', signal, (f) => readRoles(f, account)),
      );
      return { ...data, processRef, mutable: canManagePlayerAccounts(version) };
    },
    async zones(who: AuthContext, id: string, account: string) {
      const {
        data: zones,
        version,
        processRef,
      } = await read(who, id, 'territory.manage', ({ signal }) =>
        withFiles(who, id, 'territory.manage', signal, (f) => readMemberships(f, account)),
      );
      return { zones, processRef, mutable: canManagePlayerAccounts(version) };
    },
    async change(who: AuthContext, id: string, input: ModerationRequest) {
      const { action } = input,
        grant = grants[action.kind];
      const scope = await scopeFor(who, id, grant);
      const receipt = openworldActionReceipt(db, who, id, 'player', input, {
        playerAction: action.kind,
        targetAccount: action.account,
      });
      const previous = await receipt.existing();
      if (previous) return previous;
      if (scope.reason) throw new DomainError('game_not_ready');
      if (openworldProcessRef(scope) !== input.processRef) throw new DomainError('conflict');
      const supported =
        action.kind === 'unban'
          ? canChangeOpenworldLegacyRules(scope.version)
          : canManagePlayerAccounts(scope.version);
      if (!supported) throw new DomainError('game_request_unsupported');
      const result = await connect(
        scope,
        (origin, token, signal) =>
          receipt.run((mark) =>
            db.transaction().execute(async (tx) => {
              const lock = await sql<{
                ok: boolean;
              }>`select pg_try_advisory_xact_lock(hashtextextended(current_schema() || ${`:openworld:rules:${id}`},0)) as ok`.execute(
                tx,
              );
              if (!lock.rows[0]?.ok) throw new DomainError('conflict');
              const native = { origin, token, signal, fetcher };
              const getRole = () =>
                withFiles(who, id, grant, signal, (f) => readRoles(f, action.account));
              const getZone = async (input: Extract<ModerationChange, { kind: 'member' }>) => {
                const zones = await withFiles(who, id, grant, signal, (f) =>
                  readMemberships(f, input.account),
                );
                const matches = zones.filter(
                  (z) => z.name.toLowerCase() === input.zone.toLowerCase(),
                );
                const z = matches[0];
                if (
                  matches.length !== 1 ||
                  z?.id !== input.zoneId ||
                  z.name !== input.zone ||
                  !moderationPlayerName.safeParse(z.name).success
                )
                  throw new DomainError('conflict');
                return z;
              };
              const isBanned = async () =>
                (await playerBans(native)).some((b) => b.uuid.toLowerCase() === action.account);
              if (action.kind === 'unban' || action.kind === 'ban') {
                if ((await isBanned()) !== (action.kind === 'unban'))
                  throw new DomainError('conflict');
              }
              let savedAccountMatches = false;
              if (action.kind !== 'unban') {
                const indexed = await tx
                  .selectFrom('openworld_saved_players as p')
                  .innerJoin('openworld_player_directories as d', 'd.server_id', 'p.server_id')
                  .select(['file_stem', 'revision', 'account_id', 'display_name'])
                  .where('d.server_id', '=', id)
                  .where('d.binding', '=', scope.historyBinding ?? scope.binding)
                  .execute();
                savedAccountMatches = await withFiles(who, id, grant, signal, (files) =>
                  proveSavedModerationName(files, indexed, action.account, action.name),
                );
              }
              const command =
                action.kind === 'ban'
                  ? (`ban ${action.name}${action.reason ? ` ${action.reason}` : ''}` as const)
                  : action.kind === 'unban'
                    ? (`unban ${action.account}` as const)
                    : action.kind === 'role'
                      ? (`role assign ${action.name} ${action.role}` as const)
                      : (`zone member ${action.zone} ${action.member ? 'add' : 'remove'} ${action.name}` as const);
              let dispatched = false;
              try {
                const result = (
                  await ruleReplies(native, [command], async () => {
                    if (action.kind === 'role') {
                      const old = await getRole();
                      if (
                        old.current !== action.previous ||
                        old.current === action.role ||
                        !old.roles.some((r) => r.key === action.role)
                      )
                        throw new DomainError('conflict');
                    } else if (
                      action.kind === 'member' &&
                      (await getZone(action)).member === action.member
                    )
                      throw new DomainError('conflict');
                    if (action.kind !== 'unban')
                      await confirmModerationTarget(
                        native,
                        action.account,
                        action.name,
                        savedAccountMatches,
                        action.kind === 'ban',
                      );
                    assertCurrentOpenworldScope(
                      scope,
                      await readOpenworldScope(tx, id, {
                        who,
                        resource: 'player-moderation',
                        moderationGrant: grant,
                      }),
                    );
                    if (signal.aborted) throw new DomainError('game_not_ready');
                    dispatched = true;
                    mark();
                  })
                ).get(command);
                if (result?.accepted === false) throw new DomainError('game_request_rejected');
                if (!result?.accepted) throw new DomainError('operation_uncertain');
                const success =
                  action.kind === 'ban'
                    ? await isBanned()
                    : action.kind === 'unban'
                      ? !(await isBanned())
                      : action.kind === 'role'
                        ? (await getRole()).current === action.role
                        : (await getZone(action)).member === action.member;
                if (!success) throw new DomainError('operation_uncertain');
              } catch (error) {
                if (
                  !dispatched ||
                  (error instanceof DomainError && error.code === 'game_request_rejected')
                )
                  throw error;
                if (error instanceof OpenworldTokenExpired)
                  throw new OpenworldTokenExpired('operation_uncertain');
                throw new DomainError('operation_uncertain');
              }
            }),
          ),
        false,
        30000,
      );
      assertCurrentOpenworldScope(scope, await scopeFor(who, id, grant));
      return result;
    },
  };
}
