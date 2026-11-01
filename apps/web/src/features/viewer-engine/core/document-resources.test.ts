import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../../api/client.js';
import { fileDirectoryQuery } from '../../service-contracts.js';
import { archiveQuery } from './archive-query.js';
import {
  createDocumentResources,
  documentRelativePath,
  documentResourceLimits,
} from './document-resources.js';
import type { ViewerSource } from './registry.js';
import { cachedDocumentSources } from './use-document-resources.js';

const source: ViewerSource = { path: 'notes/Start.md', name: 'Start.md', size: 10 };
const file = (name: string, size = 20) => ({ name, size, is_file: true, is_symlink: false });
const controllers: ReturnType<typeof createDocumentResources>[] = [];
function resources(extra: Partial<Parameters<typeof createDocumentResources>[0]> = {}) {
  const result = createDocumentResources({
    serverId: 'server',
    source,
    identity: 'owner',
    onOpen: vi.fn(),
    ...extra,
  });
  controllers.push(result);
  return result;
}
function listing(directory: string, names: string[]) {
  queryClient.setQueryData(
    fileDirectoryQuery('server', directory).queryKey,
    names.map((name) => file(name)),
  );
}
afterEach(() => {
  for (const item of controllers.splice(0)) item.dispose();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('shared document resources', () => {
  it('normalizes explicit sibling/root links without crossing the filesystem or archive root', () => {
    expect(documentRelativePath('../assets/a.png', 'notes/Start.md')).toBe('assets/a.png');
    expect(documentRelativePath('/a.md', 'notes/Start.md')).toBe('a.md');
    for (const path of ['../../a', '//other/a', 'https://evil/a', '\\evil', '/../../a'])
      expect(() => documentRelativePath(path, 'notes/Start.md')).toThrow();
  });
  it('resolves wiki extension fallback, heading/block anchors and aliases from the existing listing', async () => {
    listing('notes', ['Other.md', 'Image.png']);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const docs = resources();
    expect(await docs.resolve('[[Other#Chapter|Read]]', { wiki: true })).toEqual({
      kind: 'local',
      source: { path: 'notes/Other.md', name: 'Other.md', size: 20 },
      fragment: 'Chapter',
      label: 'Read',
    });
    expect(await docs.resolve('#^paragraph')).toEqual({
      kind: 'anchor',
      fragment: '^paragraph',
      label: undefined,
    });
    expect(fetcher).not.toHaveBeenCalled();
    const target = await docs.resolve('Image.png');
    expect(docs.url(target)).toBe('/v1/servers/server/files/viewer/content?path=notes%2FImage.png');
  });
  it('does not guess ambiguous known basenames or recursively scan the vault', async () => {
    listing('notes', []);
    const docs = resources({
      knownSources: [
        { path: 'a/Other.md', name: 'Other.md', size: 20 },
        { path: 'b/Other.md', name: 'Other.md', size: 20 },
      ],
    });
    await expect(docs.resolve('Other', { wiki: true })).rejects.toMatchObject({
      code: 'document_ambiguous_link',
    });
    await expect(docs.resolve('Missing', { wiki: true })).rejects.toMatchObject({
      code: 'document_link_missing',
    });
    listing('notes', ['Other.md']);
    expect(await docs.resolve('Other', { wiki: true })).toMatchObject({
      source: { path: 'notes/Other.md' },
    });
  });
  it('keeps nested archive links inside the current virtual namespace', async () => {
    const archived = {
      ...source,
      path: 'pack.zip',
      entry: 'notes/Start.md',
      archives: ['inside.zip'],
    };
    const query = archiveQuery('server', 'owner', archived, 'images', 0, 'icon.png');
    queryClient.setQueryData(query.queryKey, {
      total: 1,
      entries: [{ name: 'icon.png', path: 'images/icon.png', size: 10, directory: false }],
    });
    const docs = resources({ source: archived });
    const target = await docs.resolve('../images/icon.png');
    expect(target).toMatchObject({
      source: { path: 'pack.zip', entry: 'images/icon.png', archives: ['inside.zip'] },
    });
    expect(new URL(docs.url(target), 'https://example.test').searchParams.get('archives')).toBe(
      '["inside.zip"]',
    );
    await expect(docs.resolve('../../escape.md')).rejects.toMatchObject({
      code: 'document_path_escape',
    });
    await expect(docs.resolve('a.md', { from: source })).rejects.toMatchObject({
      code: 'document_foreign_namespace',
    });
  });
  it('permits external navigation but never external text reads or unsafe protocols', async () => {
    const docs = resources();
    const external = await docs.resolve('https://example.test/manual');
    expect(docs.url(external)).toBe('https://example.test/manual');
    await expect(docs.readText(external)).rejects.toMatchObject({
      code: 'document_local_required',
    });
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      '//evil/a',
      'https://name:password@example.test',
      '%2f%2fevil/a',
    ])
      await expect(docs.resolve(target)).rejects.toThrow();
  });
  it('deduplicates text reads; aborting one waiter does not cancel another and completed text is cached', async () => {
    listing('notes', ['Other.md']);
    let respond: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const docs = resources();
    const target = await docs.resolve('Other.md');
    const controller = new AbortController();
    const first = docs.readText(target, controller.signal);
    const second = docs.readText(target);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(
      false,
    );
    respond?.(new Response('same text'));
    expect(await second).toBe('same text');
    expect(await docs.readText(target)).toBe('same text');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds text and refuses binary data, forged resources and identity changes', async () => {
    listing('notes', ['Other.md']);
    const docs = resources();
    const target = await docs.resolve('Other.md');
    const fetcher = vi.fn(async () => new Response('binary\0content'));
    vi.stubGlobal('fetch', fetcher);
    await expect(docs.readText(target)).rejects.toMatchObject({ code: 'document_binary' });
    await expect(docs.readText({ kind: 'local', source })).rejects.toMatchObject({
      code: 'document_foreign_resource',
    });
    queryClient.setQueryData(['session'], {
      context: { actorUserId: 'different', subjectUserId: 'different', sessionType: 'regular' },
    });
    await expect(docs.readText(target)).rejects.toMatchObject({
      code: 'document_identity_changed',
    });
  });
  it('uses one bounded cache per document and disposal aborts outstanding reads', async () => {
    const names = Array.from({ length: 34 }, (_, index) => `File${index}.md`);
    listing('notes', names);
    const docs = resources();
    const fetcher = vi.fn(async () => new Response('content'));
    vi.stubGlobal('fetch', fetcher);
    for (const name of names) await docs.readText(await docs.resolve(name));
    await docs.readText(await docs.resolve(names[0] ?? ''));
    expect(fetcher).toHaveBeenCalledTimes(35);
    expect(documentResourceLimits.cacheEntries).toBe(32);
    docs.dispose();
    await expect(docs.resolve('Start.md')).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('enforces metadata and streaming byte limits before retaining documents', async () => {
    queryClient.setQueryData(fileDirectoryQuery('server', 'notes').queryKey, [
      file('Large.md', documentResourceLimits.textBytes + 1),
      file('Changed.md', 10),
    ]);
    const docs = resources();
    const fetcher = vi.fn(
      async () =>
        new Response('large', {
          headers: { 'content-length': String(documentResourceLimits.textBytes + 1) },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(docs.readText(await docs.resolve('Large.md'))).rejects.toMatchObject({
      code: 'document_text_limit',
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(docs.readText(await docs.resolve('Changed.md'))).rejects.toMatchObject({
      messageKey: 'viewer.tooLarge',
    });
  });
  it('aborts the owned transport on disposal and does not retain failed loads', async () => {
    listing('notes', ['Other.md']);
    const docs = resources();
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const target = await docs.resolve('Other.md');
    const read = docs.readText(target);
    docs.dispose();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });
  it('discovers only already-indexed metadata for the active server and session', async () => {
    const context = { actorUserId: 'a', subjectUserId: 'a', sessionType: 'regular' };
    queryClient.setQueryData(['session'], { context });
    listing('notes', []);
    listing('known', ['Shared.md']);
    queryClient.setQueryData(
      ['files', 'server', 'foreign', ['other', 'other', 'regular', '']],
      [file('Shared.md')],
    );
    queryClient.setQueryData(
      ['files', 'different-server', 'known', ['a', 'a', 'regular', '']],
      [file('Shared.md')],
    );
    const docs = resources({
      knownSources: () => cachedDocumentSources('server', 'owner', source),
    });
    expect(await docs.resolve('Shared', { wiki: true })).toMatchObject({
      source: { path: 'known/Shared.md' },
    });
    listing('later-indexed', ['Another.md']);
    expect(await docs.resolve('Another', { wiki: true })).toMatchObject({
      source: { path: 'later-indexed/Another.md' },
    });
    expect(cachedDocumentSources('server', 'owner', source).map((file) => file.path)).toEqual([
      'known/Shared.md',
      'later-indexed/Another.md',
    ]);
  });
  it('does not reuse another archive container or identity index', () => {
    const archived = {
      ...source,
      path: 'outer.zip',
      archives: ['inside.zip'],
      entry: 'notes/Start.md',
    };
    const fill = (identity: string, input: ViewerSource, name: string) =>
      queryClient.setQueryData(archiveQuery('server', identity, input).queryKey, {
        entries: [{ name, path: name, size: 20, directory: false }],
      });
    fill('owner', archived, 'Good.md');
    fill('other', archived, 'Foreign.md');
    fill('owner', { ...archived, archives: ['other.zip'] }, 'Wrong-container.md');
    expect(cachedDocumentSources('server', 'owner', archived).map((file) => file.entry)).toEqual([
      'Good.md',
    ]);
  });
  it('queues valid inclusions above eight active reads instead of failing them', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `Queued${index}.md`);
    listing('notes', names);
    const docs = resources();
    const responders: (() => void)[] = [];
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => responders.push(() => resolve(new Response('text')))),
    );
    vi.stubGlobal('fetch', fetcher);
    const targets = await Promise.all(names.map((name) => docs.resolve(name)));
    const reads = targets.map((target) => docs.readText(target));
    expect(fetcher).toHaveBeenCalledTimes(8);
    responders.shift()?.();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(9));
    responders.shift()?.();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(10));
    for (const respond of responders) respond();
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 10 }, () => 'text'));
  });
  it('rejects queued and active consumers on disposal without starting more transports', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `Abort${index}.md`);
    listing('notes', names);
    const docs = resources();
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const targets = await Promise.all(names.map((name) => docs.resolve(name)));
    const reads = targets.map((target) => docs.readText(target));
    docs.dispose();
    const results = await Promise.allSettled(reads);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });
  it('drains the queue safely if identity changes before a waiting read starts', async () => {
    const names = Array.from({ length: 9 }, (_, index) => `Identity${index}.md`);
    listing('notes', names);
    const docs = resources();
    const responders: (() => void)[] = [];
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => responders.push(() => resolve(new Response('text')))),
    );
    vi.stubGlobal('fetch', fetcher);
    const targets = await Promise.all(names.map((name) => docs.resolve(name)));
    const reads = targets.map((target) => docs.readText(target));
    queryClient.setQueryData(['session'], {
      context: { actorUserId: 'new', subjectUserId: 'new', sessionType: 'regular' },
    });
    for (const respond of responders) respond();
    const results = await Promise.allSettled(reads);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });
  it('passes fragment to the host when opening links', async () => {
    listing('notes', ['Other.md']);
    const onOpen = vi.fn();
    const docs = resources({ onOpen });
    const target = await docs.resolve('Other.md#A');
    docs.open(target);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'notes/Other.md' }), 'A');
  });
});
