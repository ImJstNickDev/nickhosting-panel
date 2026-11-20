import { DomainError } from '@nickhosting/core';
import type { GameLifecycleContext } from './lifecycle.js';

/** Match only server-thread command receipts, never a player's chat or command
 * echo. Unsupported server logging formats fail closed and leave an actionable
 * cleanup error instead of claiming that saving has finished. */
const receipt = (message: string) =>
  new RegExp(`^\\[\\d{2}:\\d{2}:\\d{2}\\] \\[Server thread/INFO\\]: (?:${message})$`);

async function confirmedCommands(
  context: GameLifecycleContext,
  commands: readonly (readonly [string, RegExp])[],
): Promise<void> {
  const authorize = async () => {
    try {
      await context.authorize();
      return true;
    } catch {
      return false;
    }
  };
  let pending: { expected: RegExp; resolve(): void; reject(error: Error): void } | undefined;
  let closed = false;
  const relay = await context.adapter.relayConsole(context.server.pterodactyl_identifier ?? '', {
    authorize,
    authorizeCommand: authorize,
    canSendCommands: true,
    maxDurationMs: 30_000 * commands.length,
    onEvent(event) {
      if (event.type === 'closed' || event.type === 'error') {
        closed = true;
        pending?.reject(new DomainError('integration_unavailable'));
      } else if (event.type === 'console' && pending?.expected.test(event.data.trim())) {
        pending.resolve();
      }
    },
  });
  try {
    for (const [text, expected] of commands) {
      await context.authorize();
      if (closed) throw new DomainError('integration_unavailable');
      const completion = Promise.withResolvers<void>();
      pending = { expected, resolve: completion.resolve, reject: completion.reject };
      const timer = setTimeout(
        () => completion.reject(new DomainError('operation_uncertain')),
        30_000,
      );
      try {
        await Promise.all([completion.promise, relay.sendCommand(text)]);
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
    }
  } finally {
    relay.close();
  }
}

export async function prepareMinecraftBackup(
  context: GameLifecycleContext,
  mode: 'offline' | 'live',
) {
  if (mode === 'offline') return;
  if (
    (await context.adapter.getResources(context.server.pterodactyl_identifier ?? ''))
      .current_state === 'offline'
  ) {
    await context.assertStopped();
    return;
  }
  // Persist before save-off. A failed or lost response still requires save-on.
  await context.update({
    plan: { ...context.operation().plan, minecraftBackupSavingMayBeDisabled: true },
  });
  await confirmedCommands(context, [
    ['save-off', receipt('Automatic saving is now disabled|Saving is already turned off')],
    ['save-all flush', receipt('Saved the game')],
  ]);
}

export async function cleanupMinecraftBackup(
  context: GameLifecycleContext,
  mode: 'offline' | 'live',
) {
  if (mode === 'offline' || context.operation().plan.minecraftBackupSavingMayBeDisabled !== true)
    return;
  try {
    await context.assertStopped();
    // save-off is process-local. A trusted physical stop retires the obligation;
    // cached Panel status alone never does, and no reservation is released here.
    await context.update({
      plan: { ...context.operation().plan, minecraftBackupSavingMayBeDisabled: false },
    });
    return;
  } catch (error) {
    if (!(error instanceof DomainError && error.code === 'operation_uncertain')) throw error;
  }
  await confirmedCommands(context, [
    ['save-on', receipt('Automatic saving is now enabled|Saving is already turned on')],
  ]);
  await context.update({
    plan: { ...context.operation().plan, minecraftBackupSavingMayBeDisabled: false },
  });
}
