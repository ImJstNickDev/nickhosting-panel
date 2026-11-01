import { DomainError } from '@nickhosting/core';
import type { ConsoleRelayOptions } from '@nickhosting/pterodactyl-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameLifecycleContext } from './lifecycle.js';
import { cleanupMinecraftBackup, prepareMinecraftBackup } from './minecraft-backup.js';

function fixture() {
  let plan: Record<string, unknown> = {};
  let listener: ConsoleRelayOptions['onEvent'] = () => {};
  const close = vi.fn();
  const sendCommand = vi.fn(async (command: string) => {
    const receipt =
      command === 'save-off'
        ? 'Automatic saving is now disabled'
        : command === 'save-on'
          ? 'Automatic saving is now enabled'
          : 'Saved the game';
    listener({ type: 'console', data: `[12:34:56] [Server thread/INFO]: ${receipt}` });
  });
  const context = {
    server: { pterodactyl_identifier: 'fixture' },
    operation: () => ({ plan }),
    update: async (patch: { plan: Record<string, unknown> }) => {
      plan = patch.plan;
    },
    authorize: vi.fn(async () => {}),
    assertStopped: async () => {
      throw new DomainError('operation_uncertain');
    },
    adapter: {
      getResources: async () => ({ current_state: 'running' }),
      relayConsole: vi.fn(async (_id: string, options: ConsoleRelayOptions) => {
        listener = options.onEvent;
        return { sendCommand, close };
      }),
    },
  } as unknown as GameLifecycleContext;
  return {
    context,
    sendCommand,
    close,
    emit: (data: string) => listener({ type: 'console', data }),
  };
}
afterEach(() => vi.useRealTimers());
describe('Minecraft backup hooks', () => {
  it('confirms save-off and flush before backup and confirms cleanup save-on', async () => {
    const f = fixture();
    await prepareMinecraftBackup(f.context, 'live');
    expect(f.sendCommand.mock.calls.map(([command]) => command)).toEqual([
      'save-off',
      'save-all flush',
    ]);
    expect(f.context.operation().plan.minecraftBackupSavingMayBeDisabled).toBe(true);
    await cleanupMinecraftBackup(f.context, 'live');
    expect(f.sendCommand).toHaveBeenLastCalledWith('save-on');
    expect(f.context.operation().plan.minecraftBackupSavingMayBeDisabled).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(3);
  });
  it('rejects missing receipts despite successful command sends and still cleans up', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const normal = f.sendCommand.getMockImplementation();
    if (!normal) throw new Error('Missing mock implementation');
    f.sendCommand.mockImplementationOnce(normal).mockImplementationOnce(async () => {
      f.emit('[12:34:56] [Server thread/INFO]: <player> Saved the game');
    });
    const pending = prepareMinecraftBackup(f.context, 'live');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'operation_uncertain' });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(f.context.operation().plan.minecraftBackupSavingMayBeDisabled).toBe(true);
    await cleanupMinecraftBackup(f.context, 'live');
    expect(f.sendCommand).toHaveBeenLastCalledWith('save-on');
  });
  it('does not send live save commands for a confirmed offline backup', async () => {
    const f = fixture();
    await prepareMinecraftBackup(f.context, 'offline');
    await cleanupMinecraftBackup(f.context, 'offline');
    expect(f.sendCommand).not.toHaveBeenCalled();
  });
});

it('retires process-local save-off after a trusted physical stop without sending commands', async () => {
  const f = fixture();
  await prepareMinecraftBackup(f.context, 'live');
  f.context.assertStopped = async () => {};
  await cleanupMinecraftBackup(f.context, 'live');
  expect(f.sendCommand.mock.calls.map(([command]) => command)).toEqual([
    'save-off',
    'save-all flush',
  ]);
  expect(f.context.operation().plan.minecraftBackupSavingMayBeDisabled).toBe(false);
});
