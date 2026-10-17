import { createHash } from 'node:crypto';
import { type AuthContext, DomainError, gatewayMessageOverridesSchema } from '@nickhosting/core';
import { getSettings, notifyGatewayChange, recordAudit } from '@nickhosting/database';
import {
  gatewayMessageDefinitionSchema,
  validateGatewayMessageOverrides,
} from '@nickhosting/game-sdk';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { trustedGameModules } from './game-modules.js';
import { currentInteractiveContext } from './interactive-context.js';
import { authorizeServer, parse } from './registry.js';

type MessageModules = Pick<typeof trustedGameModules, 'get'>;
const revision = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function getServerGatewayMessages(
  db: DB,
  context: AuthContext,
  serverId: string,
  env: Environment = {},
  modules: MessageModules = trustedGameModules,
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
  const module = modules.get(mapping.game_id);
  const declared = module?.manifest.gatewayMessages;
  const definition = declared
    ? gatewayMessageDefinitionSchema.parse(
        module.resolveGatewayMessages
          ? module.resolveGatewayMessages((await getSettings(db, env)).values, {
              serverName: server.name,
            })
          : declared,
      )
    : undefined;
  const available = server.connection_mode !== 'direct' && !!state && !!definition;
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
  return {
    available,
    editable,
    revision: revision({ overrides, definition }),
    overrides,
    definition,
  };
}
export async function setServerGatewayMessages(
  db: DB,
  previous: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
  modules: MessageModules = trustedGameModules,
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
    const current = await getServerGatewayMessages(tx, context, serverId, env, modules);
    if (!current.available || !current.definition) throw new DomainError('integration_unavailable');
    if (current.revision !== value.revision) throw new DomainError('conflict');
    try {
      validateGatewayMessageOverrides(current.definition, value.overrides);
    } catch {
      throw new DomainError('validation_failed');
    }
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
    return getServerGatewayMessages(tx, context, serverId, env, modules);
  });
}
