import { DomainError } from '@nickhosting/core';
import type { GameLifecycleContext } from './lifecycle.js';

/** Match only server-thread command receipts, never a player's chat or command
 * echo. Unsupported server logging formats fail closed and leave an actionable
 * cleanup error instead of claiming that saving has finished. */
const receipt = (message: string) =>
  new RegExp(`^\\[\\d{2}:\\d{2}:\\d{2}\\] \\[Server thread/INFO\\]: (?:${message})$`);

async function command(
  context: GameLifecycleContext,
  text: string,
  expected: RegExp,
): Promise<void> {
  let armed = false;
  let settle: (error?: Error) => void = () => {};
  const completion = new Promise<void>((resolve, reject) => {
    settle = (error) => (error ? reject(error) : resolve());
  });
  // Attach a rejection handler before the socket can close during authorization.
  void completion.catch(() => {});
  const timer = setTimeout(() => settle(new DomainError('operation_uncertain')), 30_000);
  let relay: Awaited<ReturnType<typeof context.adapter.relayConsole>> | undefined;
  const authorize = async () => {
    try {
      await context.authorize();
      return true;
    } catch {
      return false;
    }
  };
  try {
    relay = await context.adapter.relayConsole(context.server.pterodactyl_identifier ?? '', {
      authorize,
      authorizeCommand: authorize,
      canSendCommands: true,
      maxDurationMs: 30_000,
      onEvent(event) {
        if (event.type === 'closed' || event.type === 'error')
          settle(new DomainError('integration_unavailable'));
        if (armed && event.type === 'console' && expected.test(event.data.trim())) settle();
      },
    });
    await context.authorize();
    armed = true;
    await relay.sendCommand(text);
    await completion;
  } finally {
    clearTimeout(timer);
    relay?.close();
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
  await command(
    context,
    'save-off',
    receipt('Automatic saving is now disabled|Saving is already turned off'),
  );
  await command(context, 'save-all flush', receipt('Saved the game'));
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
  await command(
    context,
    'save-on',
    receipt('Automatic saving is now enabled|Saving is already turned on'),
  );
  await context.update({
    plan: { ...context.operation().plan, minecraftBackupSavingMayBeDisabled: false },
  });
}
