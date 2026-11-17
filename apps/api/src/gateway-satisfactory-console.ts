import { isIP } from 'node:net';
import { DomainError, resolveDnsOptions, type SecretCodec } from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import {
  type GatewayConsoleCommandResponse,
  type GatewayRoute,
  gameManifestSchema,
  gatewayOfflineApiRequestSchema,
  gatewaySatisfactoryStateSchema,
} from '@nickhosting/game-sdk';
import { en, type MessageKey, translate } from '@nickhosting/i18n';
import {
  gatewaySafetyContext,
  getGatewayState,
  type ManagementRuntime,
  requestGatewayConsoleAction,
  requestGatewayWake,
  requireGatewayRoute,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import type { SatisfactoryApi } from '../../../games/satisfactory/src/api.js';
import {
  authorizeStoppedConsoleAdministrator,
  consoleAdministratorIdentity,
} from '../../../games/satisfactory/src/console-auth.js';
import {
  parseSatisfactoryConsoleCommand,
  readConsoleCommand,
  satisfactoryConsoleCommands,
} from '../../../games/satisfactory/src/console-commands.js';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import {
  resolveSatisfactoryApi,
  satisfactoryApiConfigured,
} from '../../../packages/server-management/src/satisfactory-api.js';
import { readStoppedSatisfactoryCredentials } from '../../../packages/server-management/src/satisfactory-native-credentials.js';
import { resolveIdleTimeout } from '../../../packages/server-management/src/sleep-policy.js';
import type { Variables } from './app.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip controls from console display values.
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256);
function reply(text: string, success = true): GatewayConsoleCommandResponse {
  return { status: 200, body: { data: { commandResult: text, returnValue: success } } };
}
const unauthorized = (): GatewayConsoleCommandResponse => ({
  status: 401,
  body: { errorCode: 'invalid_token' },
});

export function registerSatisfactoryConsoleApi(
  app: Hono<{ Variables: Variables }>,
  options: {
    db: Kysely<Database>;
    codec: SecretCodec;
    env: Readonly<Record<string, string | undefined>>;
    body: (c: Context) => Promise<unknown>;
    route: (input: unknown) => Promise<GatewayRoute>;
    management: () => Promise<ManagementRuntime>;
  },
): void {
  const { db, codec, env } = options;
  app.post('/internal/gateway/:gatewayId/console-command', async (c) => {
    c.header('Cache-Control', 'no-store');
    const input = z
      .strictObject({
        routeId: z.uuid(),
        routeRevision: z.number().int().positive(),
        request: gatewayOfflineApiRequestSchema,
      })
      .safeParse(await options.body(c));
    if (!input.success || input.data.request.operation !== 'RunCommand')
      throw new DomainError('validation_failed');
    const { request } = input.data;
    const command = readConsoleCommand(request.data);
    if (command === undefined) throw new DomainError('validation_failed');
    const routeInput = { routeId: input.data.routeId, routeRevision: input.data.routeRevision };
    const selected = await options.route(routeInput);
    await gatewaySafetyContext(db, selected);
    if (
      selected.protocol?.handlerId !== 'satisfactory' ||
      selected.protocol.role !== 'game' ||
      selected.public.transport !== 'tcp'
    )
      throw new DomainError('forbidden');
    const identity = consoleAdministratorIdentity(request);
    if (!identity) return c.json(unauthorized());
    const t = (key: MessageKey, parameters: Record<string, string | number> = {}) =>
      translate(selected.locale, key, parameters);
    const text = (
      key: keyof typeof en & `gateway.satisfactory.console.${string}`,
      success = true,
    ) => reply(t(key), success);
    let api: SatisfactoryApi | undefined;
    if (selected.mode === 'sleeping' && selected.wakeEnabled !== false) {
      const management = await options.management();
      const authority = await readStoppedSatisfactoryCredentials(db, selected.serverId, {
        adapter: management.adapter,
        confirmStopped: management.lifecycle.confirmInitialInstallationStopped,
      });
      if (!authority || authority.generation !== selected.generation)
        throw new DomainError('integration_unavailable');
      if (!authorizeStoppedConsoleAdministrator(authority.credentials, request))
        return c.json(unauthorized());
    } else if (['online', 'waking', 'blocked'].includes(selected.mode)) {
      // This is the original player's token, never the platform application token.
      api = await resolveSatisfactoryApi(
        db,
        codec,
        selected.serverId,
        identity.token,
        identity.playerId,
      );
      try {
        if (
          !(await api.verifyConsoleAdministrator(identity.fingerprint, AbortSignal.timeout(3000)))
        )
          return c.json(unauthorized());
      } catch (error) {
        if (error instanceof DomainError && ['unauthenticated', 'forbidden'].includes(error.code))
          return c.json(unauthorized());
        return c.json({
          status: 503,
          body: {
            errorCode: 'server_unavailable',
            errorMessage: t('gateway.satisfactory.console.busy'),
          },
        });
      }
    } else
      return c.json({
        status: 503,
        body: {
          errorCode: 'server_unavailable',
          errorMessage: t('gateway.satisfactory.console.restricted'),
        },
      });
    const revalidate = async (tx: Kysely<Database> = db) => {
      const current = await requireGatewayRoute(tx, selected.id, selected.revision, env, {
        revisionPrecondition: true,
      });
      if (
        current.generation !== selected.generation ||
        current.mode !== selected.mode ||
        current.wakeEnabled !== selected.wakeEnabled
      )
        throw new DomainError('conflict');
    };
    await revalidate();
    const parsed = parseSatisfactoryConsoleCommand(command);
    if (parsed.kind === 'invalid')
      return c.json(text('gateway.satisfactory.console.invalid', false));
    if (parsed.kind === 'native')
      return c.json(text('gateway.satisfactory.console.nativeUnavailable', false));
    const state = await getGatewayState(db, selected.serverId, { env });
    let result: GatewayConsoleCommandResponse;
    if (parsed.name === 'help') {
      const entries = satisfactoryConsoleCommands.filter(
        (entry) => !parsed.helpFor || entry.name === parsed.helpFor,
      );
      result = reply(
        entries
          .map((entry) => `nickhosting ${entry.usage} — ${t(entry.descriptionKey)}`)
          .join('\n'),
      );
    } else if (parsed.name === 'mods') result = text('gateway.satisfactory.console.mods');
    else if (parsed.name === 'status') {
      const message =
        state.sleepJobId && state.state === 'blocked'
          ? t('gateway.satisfactory.console.stopping')
          : t(`gateway.states.${state.state}`);
      const errorKey = `errors.${state.errorCode}`;
      result = reply(
        t('gateway.satisfactory.console.state', { state: message }) +
          (state.errorCode && Object.hasOwn(en, errorKey) ? `\n${t(errorKey as MessageKey)}` : ''),
      );
    } else if (parsed.name === 'info') {
      const server = await db
        .selectFrom('managed_servers')
        .select('name')
        .where('id', '=', selected.serverId)
        .executeTakeFirstOrThrow();
      const config = await getSettings(db, env);
      const integration = await db
        .selectFrom('game_integrations')
        .select('manifest')
        .where('id', '=', 'satisfactory')
        .executeTakeFirst();
      const manifest = gameManifestSchema.safeParse(integration?.manifest);
      const host = manifest.success
        ? resolveDnsOptions(config.values, manifest.data.connection, 'satisfactory').defaultHostname
        : null;
      const address = host
        ? `${isIP(host) === 6 ? `[${host}]` : host}:${selected.public.port}`
        : t('gateway.satisfactory.console.unknown');
      result = reply(
        [
          t('gateway.satisfactory.console.name', { name: clean(server.name) }),
          t('gateway.satisfactory.console.game'),
          t('gateway.satisfactory.console.address', { address }),
        ].join('\n'),
      );
    } else if (parsed.name === 'version') {
      const row = await db
        .selectFrom('satisfactory_server_state')
        .select('snapshot')
        .where('server_id', '=', selected.serverId)
        .executeTakeFirst();
      const snapshot = gatewaySatisfactoryStateSchema.safeParse(row?.snapshot);
      result = reply(
        [
          t('gateway.satisfactory.console.integrationVersion', {
            version: satisfactoryManifest.version,
          }),
          t('gateway.satisfactory.console.observedBuild', {
            build: snapshot.success
              ? snapshot.data.netCL
              : t('gateway.satisfactory.console.unknown'),
          }),
        ].join('\n'),
      );
    } else if (parsed.name === 'idle') {
      const raw = await db
        .selectFrom('gateway_server_states')
        .selectAll()
        .where('server_id', '=', selected.serverId)
        .executeTakeFirstOrThrow();
      const timeout = await resolveIdleTimeout(db, selected.serverId, raw, env);
      const lines = [
        timeout.effectiveSeconds < 0
          ? t('gateway.satisfactory.console.idleDisabled')
          : t('gateway.satisfactory.console.timeout', { seconds: timeout.effectiveSeconds }),
        t('gateway.satisfactory.console.idleConditions'),
      ];
      if (api && selected.mode === 'online') {
        lines.push(t('gateway.satisfactory.console.idleActivity'));
        try {
          const signal = AbortSignal.timeout(1500);
          const game = await api.state(signal);
          lines.push(
            t('gateway.satisfactory.console.players', { count: game.numConnectedPlayers }),
          );
          const hasWorld =
            game.isGameRunning ||
            (await api.sessions(signal)).sessions.some((session) => session.saveHeaders.length > 0);
          lines.push(
            t(
              hasWorld
                ? 'gateway.satisfactory.console.world'
                : 'gateway.satisfactory.console.noWorld',
            ),
          );
        } catch {
          lines.push(t('gateway.satisfactory.console.unknown'));
        }
      }
      const server = await db
        .selectFrom('managed_servers')
        .select('active_operation_id')
        .where('id', '=', selected.serverId)
        .executeTakeFirstOrThrow();
      if (server.active_operation_id) lines.push(t('gateway.satisfactory.console.operation'));
      result = reply(lines.join('\n'));
    } else {
      const action = parsed.name;
      if (action === 'start' && state.state === 'online')
        return c.json(text('gateway.satisfactory.console.online'));
      if ((action === 'start' || action === 'restart') && state.state === 'waking')
        return c.json(text('gateway.satisfactory.console.starting'));
      if (action === 'stop' && state.state === 'sleeping')
        return c.json(text('gateway.satisfactory.console.sleeping'));
      if (action === 'restart' && state.state === 'sleeping')
        return c.json(text('gateway.satisfactory.console.restartSleeping', false));
      if (action !== 'start' && state.state !== 'online')
        return c.json(text('gateway.satisfactory.console.busy', false));
      if (action !== 'start' && !(await satisfactoryApiConfigured(db, selected.serverId)))
        return c.json(text('gateway.satisfactory.console.saveUnavailable', false));
      const validateObservation = async (tx: Transaction<Database>) => {
        await revalidate(tx);
      };
      try {
        const management = await options.management();
        if (action === 'start' || action === 'restart')
          await management.refreshObservations(db, selected.serverId);
        const next =
          action === 'start'
            ? await requestGatewayWake(
                db,
                selected.serverId,
                { generation: selected.generation, intent: 'join' },
                { env, validateObservation, consolePlayerId: identity.playerId },
              )
            : await requestGatewayConsoleAction(
                db,
                selected.serverId,
                {
                  generation: selected.generation,
                  action: action === 'stop' ? 'sleep' : 'restart',
                  playerId: identity.playerId,
                },
                { env, validateObservation },
              );
        const accepted =
          action === 'stop' ? !!next.sleepJobId : !!next.wakeJobId && next.state === 'waking';
        if (!accepted) return c.json(text('gateway.satisfactory.console.restricted', false));
        result = text(
          action === 'start'
            ? 'gateway.satisfactory.console.startAccepted'
            : action === 'stop'
              ? 'gateway.satisfactory.console.stopAccepted'
              : 'gateway.satisfactory.console.restartAccepted',
        );
        result.transition = {
          action: action === 'stop' ? 'sleep' : action,
          previousGeneration: selected.generation,
          generation: next.generation,
        };
        return c.json(result);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return c.json(
          text(
            error.code === 'conflict' || error.code === 'operation_busy'
              ? 'gateway.satisfactory.console.busy'
              : 'gateway.satisfactory.console.restricted',
            false,
          ),
        );
      }
    }
    await revalidate();
    return c.json(result);
  });
}
