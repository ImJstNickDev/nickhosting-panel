import { expect, it, vi } from 'vitest';
import { gameDirectoryExists } from './fileman-location.js';

const directory = (name: string) => ({ name, is_file: false, is_symlink: false });
it('does not request a missing optional directory or create it', async () => {
  const list = vi.fn(async (path: string) => (path === '' ? [directory('FactoryGame')] : []));
  expect(await gameDirectoryExists('FactoryGame/Mods', list, new AbortController().signal)).toBe(
    false,
  );
  expect(list.mock.calls).toEqual([[''], ['FactoryGame']]);
});
it('requires every component to be a real directory', async () => {
  for (const item of [
    { ...directory('FactoryGame'), is_file: true },
    { ...directory('FactoryGame'), is_symlink: true },
  ]) {
    expect(
      await gameDirectoryExists(
        'FactoryGame/Mods',
        async () => [item],
        new AbortController().signal,
      ),
    ).toBe(false);
  }
  expect(
    await gameDirectoryExists(
      'FactoryGame/Mods',
      async (parent) => [directory(parent ? 'Mods' : 'FactoryGame')],
      new AbortController().signal,
    ),
  ).toBe(true);
});
it('preserves provider and authorization failures instead of inventing an empty directory', async () => {
  const failure = new Error('provider_failed');
  await expect(
    gameDirectoryExists(
      'FactoryGame/Mods',
      async () => {
        throw failure;
      },
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
});
it('abandons stale navigation before reading the next component', async () => {
  const controller = new AbortController();
  const list = vi.fn(async () => {
    controller.abort();
    return [directory('FactoryGame')];
  });
  await expect(gameDirectoryExists('FactoryGame/Mods', list, controller.signal)).rejects.toThrow();
  expect(list).toHaveBeenCalledOnce();
});
