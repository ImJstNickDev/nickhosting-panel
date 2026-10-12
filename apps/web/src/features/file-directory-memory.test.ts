import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it } from 'vitest';
import { FileDirectoryMemory } from './file-directory-memory.js';
import type { ServerFile } from './service-contracts.js';

const file: ServerFile = {
  name: 'data.json',
  is_file: true,
  is_symlink: false,
  size: 100,
  mode: '-rw-r--r--',
  mimetype: 'application/json',
  created_at: '',
  modified_at: '',
};
const files = [file];
const key = (path: string) => ['files', 'server', path, ['owner']] as const;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let memory: FileDirectoryMemory;
afterEach(() => {
  memory.dispose();
  client.clear();
});

it('bounds directory counts and serialized metadata, evicting least-recently-used inactive listings', () => {
  memory = new FileDirectoryMemory(client, { directories: 2, bytes: 2048 });
  client.setQueryData(key('one'), files);
  client.setQueryData(key('two'), files);
  memory.read(key('one'));
  expect(memory.write(key('three'), files, memory.capture(key('three')))).toBe(true);
  expect(memory.read(key('two'))).toBeUndefined();
  expect(memory.read(key('one'))).toEqual(files);
  expect(
    memory.write(key('huge'), [{ ...file, name: 'x'.repeat(4096) }], memory.capture(key('huge'))),
  ).toBe(false);
  expect(memory.read(key('huge'))).toBeUndefined();
  expect(memory.read(key('one'))).toEqual(files);
  expect(memory.read(key('three'))).toEqual(files);
});

it('preserves observed queries and declines speculation when the active listing fills the budget', () => {
  memory = new FileDirectoryMemory(client, { directories: 1, bytes: 2048 });
  client.setQueryData(key('active'), files);
  const observer = new QueryObserver(client, { queryKey: key('active'), enabled: false });
  const unsubscribe = observer.subscribe(() => {});
  expect(memory.write(key('new'), files, memory.capture(key('new')))).toBe(false);
  expect(memory.read(key('active'))).toEqual(files);
  unsubscribe();
});

it('never overwrites newer foreground metadata or a mutation invalidation', async () => {
  memory = new FileDirectoryMemory(client);
  const before = memory.capture(key('new'));
  client.setQueryData(key('new'), [{ ...file, size: 200 }]);
  expect(memory.write(key('new'), files, before)).toBe(false);
  const absent = memory.capture(key('other'));
  await client.invalidateQueries({ queryKey: ['files'], refetchType: 'none' });
  expect(memory.write(key('other'), files, absent)).toBe(false);
});

it('does not replace or evict foreground data while its request is still in flight', async () => {
  memory = new FileDirectoryMemory(client, { directories: 1, bytes: 2048 });
  const deferred = Promise.withResolvers<ServerFile[]>();
  const request = client.fetchQuery({ queryKey: key('active'), queryFn: () => deferred.promise });
  const before = memory.capture(key('active'));
  expect(memory.write(key('active'), files, before)).toBe(false);
  deferred.resolve(files);
  await request;
  expect(memory.read(key('active'))).toEqual(files);
});
