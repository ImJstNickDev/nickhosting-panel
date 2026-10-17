import { createHash } from 'node:crypto';
import {
  type AuthContext,
  DomainError,
  gatewayMessageDefaults,
  gatewayMessageOverridesSchema,
  gatewayMessageStates,
  gatewayMessageVariables,
} from '@nickhosting/core';
import { getSettings, notifyGatewayChange, recordAudit } from '@nickhosting/database';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { trustedGameModules } from './game-modules.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, parse } from './registry.js';

const revision = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(gatewayMessageOverridesSchema.parse(value)))
    .digest('hex');
export async function getServerGatewayMessages(
  db: DB,
  context: AuthContext,
  serverId: string,
  env: Environment = {},
) {
  const server = await authorizeServer(db, context, serverId);
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .select('game_id')
    .where('id', '=', server.mapping_id)
    .executeTakeFirstOrThrow();
  const state = await db
    .selectFrom('gateway_server_states')
    .select('gateway_messages')
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  const available =
    server.connection_mode !== 'direct' &&
    !!state &&
    trustedGameModules.get(mapping.game_id)?.manifest.capabilities.gatewayMessages === true;
  const overrides = gatewayMessageOverridesSchema.parse(state?.gateway_messages ?? {});
  // Authorize manage via the same project-scoped registry, never capability alone.
  let editable = false;
  if (available && context.sessionType === 'regular') {
    try {
      await authorizeServer(db, context, serverId, 'server:manage');
      editable = true;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'forbidden') throw error;
    }
  }
  const { values } = await getSettings(db, env);
  const responses = mapping.game_id === 'minecraft' ? values.minecraftGatewayResponses : undefined;
  const defaults = (
    id: (typeof gatewayMessageStates)[number],
    locale: 'en' | 'it',
    kind: 'motd' | 'disconnect',
  ) => {
    const configured = responses?.[kind];
    return (
      (configured && id in configured
        ? (configured as Record<string, Partial<Record<'en' | 'it', string>>>)[id]?.[locale]
        : undefined) ?? gatewayMessageDefaults[locale][id]
    );
  };
  return {
    available,
    editable,
    revision: revision(overrides),
    overrides,
    states: gatewayMessageStates.map((id) => ({
      id,
      stateText: { en: gatewayMessageDefaults.en[id], it: gatewayMessageDefaults.it[id] },
      defaults: {
        en: { motd: defaults(id, 'en', 'motd'), disconnect: defaults(id, 'en', 'disconnect') },
        it: { motd: defaults(id, 'it', 'motd'), disconnect: defaults(id, 'it', 'disconnect') },
      },
    })),
    variables: gatewayMessageVariables,
  };
}
export async function setServerGatewayMessages(
  db: DB,
  previous: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(
    z.strictObject({
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      overrides: gatewayMessageOverridesSchema,
    }),
    input,
  );
  if (previous.sessionType !== 'regular') throw new DomainError('forbidden');
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const context = await currentInteractiveContext(tx, previous, env);
    await authorizeServer(tx, context, serverId, 'server:manage');
    const current = await getServerGatewayMessages(tx, context, serverId, env);
    if (!current.available) throw new DomainError('integration_unavailable');
    if (current.revision !== value.revision) throw new DomainError('conflict');
    await tx
      .updateTable('gateway_server_states')
      .set({ gateway_messages: value.overrides, updated_at: new Date() })
      .where('server_id', '=', serverId)
      .execute();
    await notifyGatewayChange(tx);
    await recordAudit(tx, context, 'gateway.messages.updated', {
      serverId,
      states: Object.keys(value.overrides),
    });
    return getServerGatewayMessages(tx, context, serverId, env);
  });
}
