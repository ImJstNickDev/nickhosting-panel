import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuillModel } from './model.js';
import { QuillClient } from './ui-client.js';

class WorkerFixture {
  static instances: WorkerFixture[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn<(message: { id: number; source: string }) => void>();
  terminate = vi.fn();

  constructor() {
    WorkerFixture.instances.push(this);
  }

  ready() {
    this.onmessage?.({ data: { ready: true } });
  }

  reply(model: QuillModel = emptyModel) {
    const request = this.postMessage.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    this.onmessage?.({ data: { id: request?.id, model } });
  }
}

const emptyModel: QuillModel = {
  children: [],
  headings: [],
  metadata: null,
  references: [],
  tasks: [],
  warnings: [],
};
const clients: QuillClient[] = [];

function createClient() {
  const client = new QuillClient();
  clients.push(client);
  return client;
}

function currentWorker() {
  const worker = WorkerFixture.instances.at(-1);
  if (!worker) throw new Error('Expected a parser worker');
  return worker;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', WorkerFixture);
  WorkerFixture.instances = [];
});

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Quill parser worker lifecycle', () => {
  it('waits for readiness and gives a cold module load a separate startup budget', async () => {
    const client = createClient();
    const result = client.parse('# Cold document');
    const worker = currentWorker();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.ready();
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({
      id: expect.any(Number),
      source: '# Cold document',
    });
    // The original startup deadline must no longer apply after readiness.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.reply();
    await expect(result).resolves.toEqual(emptyModel);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects every waiting parse and terminates a worker that never becomes ready at 20 seconds', async () => {
    const client = createClient();
    const results = [client.parse('document'), client.parse('included document')];
    const rejected = results.map((result) =>
      expect(result).rejects.toMatchObject({ messageKey: 'quill.loadFailed' }),
    );
    const worker = currentWorker();

    await vi.advanceTimersByTimeAsync(19_999);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(rejected);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds actual parsing to 12 seconds after readiness and rejects all affected requests', async () => {
    const client = createClient();
    const results = [client.parse('document'), client.parse('included document')];
    const rejected = results.map((result) =>
      expect(result).rejects.toMatchObject({ messageKey: 'quill.renderFailed' }),
    );
    const worker = currentWorker();
    await vi.advanceTimersByTimeAsync(15_000);
    worker.ready();
    await vi.advanceTimersByTimeAsync(11_999);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(rejected);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['startup timeout', 'execution timeout', 'worker load error'] as const)(
    'recreates a failed worker for the same source on the same client after %s',
    async (failure) => {
      const client = createClient();
      const source = '![[retry.md]]';
      const first = client.parse(source);
      const failedWorker = currentWorker();
      const rejected = expect(first).rejects.toMatchObject({
        messageKey: failure === 'execution timeout' ? 'quill.renderFailed' : 'quill.loadFailed',
      });

      if (failure === 'execution timeout') {
        failedWorker.ready();
        await vi.advanceTimersByTimeAsync(12_000);
      } else if (failure === 'startup timeout') {
        await vi.advanceTimersByTimeAsync(20_000);
      } else {
        failedWorker.onerror?.();
      }
      await rejected;
      expect(failedWorker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      const retry = client.parse(source);
      const replacement = currentWorker();
      expect(replacement).not.toBe(failedWorker);
      expect(WorkerFixture.instances).toHaveLength(2);
      expect(replacement.postMessage).not.toHaveBeenCalled();
      // A late event from the failed generation cannot release the replacement.
      failedWorker.ready();
      expect(replacement.postMessage).not.toHaveBeenCalled();
      replacement.ready();
      await Promise.resolve();
      expect(replacement.postMessage).toHaveBeenCalledExactlyOnceWith({
        id: expect.any(Number),
        source,
      });
      replacement.reply();
      await expect(retry).resolves.toEqual(emptyModel);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('reports invalid parse results as rendering failures and permits retry', async () => {
    const client = createClient();
    const source = 'invalid document';
    const result = client.parse(source);
    const rejected = expect(result).rejects.toMatchObject({ messageKey: 'quill.renderFailed' });
    const worker = currentWorker();
    worker.ready();
    await Promise.resolve();
    const request = worker.postMessage.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    worker.onmessage?.({ data: { id: request?.id, error: 'markdown_invalid' } });
    await rejected;
    expect(vi.getTimerCount()).toBe(0);

    const retry = client.parse(source);
    const retryWorker = currentWorker();
    retryWorker.ready();
    await Promise.resolve();
    const retryRequest = retryWorker.postMessage.mock.calls.at(-1)?.[0];
    expect(retryRequest).toBeDefined();
    retryWorker.onmessage?.({ data: { id: retryRequest?.id, model: emptyModel } });
    await expect(retry).resolves.toEqual(emptyModel);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates concurrent sources and ignores repeated readiness announcements', async () => {
    const client = createClient();
    const result = client.parse('shared inclusion');
    expect(client.parse('shared inclusion')).toBe(result);
    const worker = currentWorker();
    expect(worker.postMessage).not.toHaveBeenCalled();

    worker.ready();
    worker.ready();
    await Promise.resolve();
    expect(client.parse('shared inclusion')).toBe(result);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.reply();
    await expect(result).resolves.toEqual(emptyModel);
    expect(client.parse('shared inclusion')).toBe(result);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['startup', 'parsing'] as const)(
    'permanently closes on disposal during %s and clears every pending timer',
    async (stage) => {
      const client = createClient();
      const results = [client.parse('document'), client.parse('inclusion')];
      const rejected = results.map((result) => expect(result).rejects.toBeInstanceOf(Error));
      const worker = currentWorker();
      if (stage === 'parsing') {
        worker.ready();
        await Promise.resolve();
      }

      client.dispose();
      client.dispose();
      await Promise.all(rejected);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      const postsBeforeLateReadiness = worker.postMessage.mock.calls.length;
      worker.ready();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(worker.postMessage).toHaveBeenCalledTimes(postsBeforeLateReadiness);
      await expect(client.parse('document')).rejects.toBeInstanceOf(Error);
      await expect(client.parse('new inclusion')).rejects.toBeInstanceOf(Error);
      expect(WorkerFixture.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
