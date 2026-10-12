import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, queryClient } from '../api/client.js';
import { identityChanged, type WebSession } from '../app/session.js';
import {
  discardFileSave,
  fileSaveScope,
  getFileSave,
  submitFileSave,
  updateFileSaveDraft,
} from './file-background-save.js';

function session(subject = 'owner', support?: string): WebSession {
  const user = {
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.invalid',
    emailVerified: true,
    locale: 'en' as const,
    role: 'owner' as const,
    twoFactorEnabled: false,
  };
  return {
    actor: user,
    subject: { ...user, id: subject },
    context: {
      actorUserId: user.id,
      subjectUserId: subject,
      role: 'owner',
      sessionType: support ? 'support' : 'regular',
      ownerElevation: false,
      ...(support
        ? {
            support: {
              id: support,
              expiresAt: '',
              reason: '',
              startedAt: '',
              lastActivityAt: '',
            },
          }
        : {}),
    },
  };
}
function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const input = {
  serverId: 'server-a',
  path: '/settings.json',
  content: '{"first":true}',
  expectedRevision: 'old-revision',
};
afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('session-private background file saves', () => {
  it('captures the submitted revision and content while retaining additional typing for recovery', async () => {
    const request = deferred();
    const fetch = vi.fn((_path: string, _options: RequestInit) => request.promise);
    vi.stubGlobal('fetch', fetch);
    const scope = fileSaveScope(session());
    const result = submitFileSave(scope, input);
    const completion = getFileSave(scope, input.serverId, input.path)?.completion;
    expect(completion).toBeInstanceOf(Promise);
    updateFileSaveDraft(scope, input.serverId, input.path, 'newer local draft');
    expect(getFileSave(scope, input.serverId, input.path)).toMatchObject({
      status: 'pending',
      content: 'newer local draft',
      submittedContent: input.content,
      expectedRevision: input.expectedRevision,
      completion,
    });
    const options = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(options).toMatchObject({ method: 'PUT', credentials: 'same-origin' });
    expect(JSON.parse(String(options?.body))).toEqual({
      path: input.path,
      content: input.content,
      expectedRevision: input.expectedRevision,
    });
    request.resolve(Response.json({ revision: 'confirmed' }));
    await expect(result).resolves.toEqual({ revision: 'confirmed' });
    await expect(completion).resolves.toEqual({ revision: 'confirmed' });
    expect(getFileSave(scope, input.serverId, input.path)).toBeUndefined();
  });

  it('refuses a duplicate write without replaying or pretending the second draft was saved', async () => {
    const request = deferred();
    const fetch = vi.fn(() => request.promise);
    vi.stubGlobal('fetch', fetch);
    const scope = fileSaveScope(session());
    const first = submitFileSave(scope, input);
    await expect(submitFileSave(scope, { ...input, content: 'different' })).rejects.toThrow(
      'file_save_pending',
    );
    discardFileSave(scope, input.serverId, input.path);
    expect(getFileSave(scope, input.serverId, input.path)?.status).toBe('pending');
    expect(fetch).toHaveBeenCalledTimes(1);
    request.resolve(Response.json({ revision: 'confirmed' }));
    await first;
  });

  it('keeps independent paths isolated when their responses complete out of order', async () => {
    const first = deferred();
    const second = deferred();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    );
    const scope = fileSaveScope(session());
    const left = submitFileSave(scope, input);
    const right = submitFileSave(scope, { ...input, path: '/other.txt' });
    second.resolve(Response.json({ revision: 'second' }));
    await right;
    expect(getFileSave(scope, input.serverId, '/other.txt')).toBeUndefined();
    expect(getFileSave(scope, input.serverId, input.path)?.status).toBe('pending');
    first.resolve(Response.json({ revision: 'first' }));
    await left;
    expect(queryClient.getQueryData(scope)).toEqual([]);
  });

  it('retains the latest draft on a failed request and discards it only deliberately', async () => {
    const request = deferred();
    const fetch = vi.fn(() => request.promise);
    vi.stubGlobal('fetch', fetch);
    const scope = fileSaveScope(session());
    const result = submitFileSave(scope, input).catch((error: unknown) => error);
    const completion = getFileSave(scope, input.serverId, input.path)?.completion;
    updateFileSaveDraft(scope, input.serverId, input.path, 'recover this draft');
    request.resolve(
      Response.json(
        { error: { code: 'conflict', messageKey: 'file.concurrentChange' } },
        { status: 409 },
      ),
    );
    expect(await result).toBeInstanceOf(ApiError);
    await expect(completion).rejects.toMatchObject({ code: 'conflict' });
    expect(getFileSave(scope, input.serverId, input.path)).toMatchObject({
      status: 'error',
      content: 'recover this draft',
      submittedContent: input.content,
      error: { code: 'conflict' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    discardFileSave(scope, input.serverId, input.path);
    expect(getFileSave(scope, input.serverId, input.path)).toBeUndefined();
  });

  it('isolates actor, subject and support-session contexts without exposing unscoped drafts', async () => {
    const request = deferred();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => request.promise),
    );
    const scope = fileSaveScope(session());
    const result = submitFileSave(scope, input);
    expect(getFileSave(undefined, input.serverId, input.path)).toBeUndefined();
    expect(
      getFileSave(fileSaveScope(session('other')), input.serverId, input.path),
    ).toBeUndefined();
    expect(
      getFileSave(fileSaveScope(session('owner', 'support-a')), input.serverId, input.path),
    ).toBeUndefined();
    const otherActor = session();
    otherActor.context.actorUserId = 'different-actor';
    expect(getFileSave(fileSaveScope(otherActor), input.serverId, input.path)).toBeUndefined();
    expect(fileSaveScope(session('other', 'support-a'))).not.toEqual(
      fileSaveScope(session('other', 'support-b')),
    );
    request.resolve(Response.json({ revision: 'confirmed' }));
    await result;
  });

  it('clears inactive records on identity change and never resurrects a late failure', async () => {
    const request = deferred();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => request.promise),
    );
    const scope = fileSaveScope(session());
    const result = submitFileSave(scope, input).catch((error: unknown) => error);
    expect(queryClient.getQueryCache().find({ queryKey: scope })?.isActive()).toBe(false);
    await identityChanged();
    request.reject(new TypeError('network_failure'));
    await result;
    expect(getFileSave(scope, input.serverId, input.path)).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: scope })).toBeUndefined();
  });

  it('cannot remove a newer attempt under the same scope after identity cache removal', async () => {
    const first = deferred();
    const second = deferred();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    );
    const scope = fileSaveScope(session());
    const old = submitFileSave(scope, input);
    await identityChanged();
    const current = submitFileSave(scope, { ...input, content: 'new identity draft' });
    first.resolve(Response.json({ revision: 'old-completion' }));
    await old;
    expect(getFileSave(scope, input.serverId, input.path)).toMatchObject({
      status: 'pending',
      content: 'new identity draft',
    });
    second.resolve(Response.json({ revision: 'current-completion' }));
    await current;
    expect(getFileSave(scope, input.serverId, input.path)).toBeUndefined();
  });
});
