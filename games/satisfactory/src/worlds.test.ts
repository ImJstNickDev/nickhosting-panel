import { expect, it, vi } from 'vitest';
import type { SatisfactoryApi } from './api.js';
import {
  changeSatisfactoryWorld,
  satisfactoryCreateWorldSchema,
  satisfactoryLoadWorldSchema,
} from './worlds.js';

function fixture() {
  return {
    state: vi.fn().mockResolvedValue({ isGameRunning: true }),
    sessions: vi.fn().mockResolvedValue({
      sessions: [{ sessionName: 'Factory', saveHeaders: [{ saveName: 'Existing' }] }],
    }),
    save: vi.fn().mockResolvedValue(undefined),
    loadWorld: vi.fn().mockResolvedValue(undefined),
    createWorld: vi.fn().mockResolvedValue(undefined),
  };
}
it('preserves current world before loading another and refuses loading after a failed save', async () => {
  const api = fixture();
  const request = {
    action: 'load' as const,
    input: { saveName: 'Existing', confirm: true as const, enableAdvancedGameSettings: false },
  };
  await changeSatisfactoryWorld(api as unknown as SatisfactoryApi, request, 'safety');
  expect(api.save).toHaveBeenCalledWith('safety');
  expect(api.loadWorld).toHaveBeenCalledWith('Existing', false);
  expect(api.save.mock.invocationCallOrder[0]).toBeLessThan(
    api.loadWorld.mock.invocationCallOrder[0] ?? 0,
  );
  api.loadWorld.mockClear();
  api.save.mockRejectedValue(new Error('save failed'));
  await expect(
    changeSatisfactoryWorld(api as unknown as SatisfactoryApi, request, 'safety'),
  ).rejects.toThrow('save failed');
  expect(api.loadWorld).not.toHaveBeenCalled();
});
it('creates the first world without trying to save a nonexistent game', async () => {
  const api = fixture();
  api.state.mockResolvedValue({ isGameRunning: false });
  await changeSatisfactoryWorld(
    api as unknown as SatisfactoryApi,
    { action: 'create', input: { sessionName: 'New', confirm: true } },
    'safety',
  );
  expect(api.save).not.toHaveBeenCalled();
  expect(api.createWorld).toHaveBeenCalledWith('New');
});
it('rejects save overwrites, duplicate sessions and nonexistent load targets before side effects', async () => {
  const api = fixture();
  for (const request of [
    { action: 'save' as const, input: { saveName: 'existing' } },
    { action: 'create' as const, input: { sessionName: 'factory', confirm: true as const } },
    {
      action: 'load' as const,
      input: { saveName: 'missing', confirm: true as const, enableAdvancedGameSettings: false },
    },
  ])
    await expect(
      changeSatisfactoryWorld(api as unknown as SatisfactoryApi, request, 'safety'),
    ).rejects.toThrow();
  expect(api.save).not.toHaveBeenCalled();
  expect(api.loadWorld).not.toHaveBeenCalled();
  expect(api.createWorld).not.toHaveBeenCalled();
});
it('requires explicit confirmation and rejects paths/control characters', () => {
  expect(satisfactoryCreateWorldSchema.safeParse({ sessionName: 'Factory' }).success).toBe(false);
  for (const saveName of ['../secret', 'a\\b', 'bad\nname'])
    expect(satisfactoryLoadWorldSchema.safeParse({ saveName, confirm: true }).success).toBe(false);
});
it('rechecks management authority before safety save and again before changing maps', async () => {
  const api = fixture();
  const authorize = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('revoked'));
  await expect(
    changeSatisfactoryWorld(
      api as unknown as SatisfactoryApi,
      {
        action: 'load',
        input: { saveName: 'Existing', enableAdvancedGameSettings: false, confirm: true },
      },
      'safety',
      authorize,
    ),
  ).rejects.toThrow('revoked');
  expect(api.save).toHaveBeenCalledWith('safety');
  expect(api.loadWorld).not.toHaveBeenCalled();
});
