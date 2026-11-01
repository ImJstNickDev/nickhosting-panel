import { useCallback, useSyncExternalStore } from 'react';
import { api, queryClient } from '../api/client.js';
import type { WebSession } from '../app/session.js';

/** In-memory drafts only. No query observer: identityChanged removes this inactive cache. */
export type FileSaveScope = readonly [string, string, string, string, string];
export type FileSaveRecord = {
  id: string;
  serverId: string;
  serverName?: string;
  path: string;
  content: string;
  submittedContent: string;
  expectedRevision: string | null;
  completion: Promise<{ revision: string }>;
  status: 'pending' | 'error';
  error?: unknown;
};
type FileSaveInput = Pick<
  FileSaveRecord,
  'serverId' | 'serverName' | 'path' | 'content' | 'expectedRevision'
>;
const empty: readonly FileSaveRecord[] = [];
queryClient.setQueryDefaults(['file-saves'], { gcTime: Number.POSITIVE_INFINITY });

export function fileSaveScope(session: WebSession): FileSaveScope {
  return [
    'file-saves',
    session.context.actorUserId,
    session.context.subjectUserId,
    session.context.sessionType,
    session.context.support?.id ?? '',
  ];
}

function records(scope: FileSaveScope | undefined): readonly FileSaveRecord[] {
  return scope ? (queryClient.getQueryData<readonly FileSaveRecord[]>(scope) ?? empty) : empty;
}

export function useFileSaveRecords(scope: FileSaveScope | undefined) {
  const subscribe = useCallback(
    (listener: () => void) => queryClient.getQueryCache().subscribe(listener),
    [],
  );
  const snapshot = useCallback(() => records(scope), [scope]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function getFileSave(scope: FileSaveScope | undefined, serverId: string, path: string) {
  return records(scope).find((record) => record.serverId === serverId && record.path === path);
}

export function updateFileSaveDraft(
  scope: FileSaveScope | undefined,
  serverId: string,
  path: string,
  content: string,
) {
  if (!scope || !getFileSave(scope, serverId, path)) return;
  queryClient.setQueryData<readonly FileSaveRecord[]>(scope, (current) =>
    current?.map((record) =>
      record.serverId === serverId && record.path === path ? { ...record, content } : record,
    ),
  );
}

/** Failed drafts are discarded deliberately; pending writes cannot be cancelled or undone here. */
export function discardFileSave(scope: FileSaveScope | undefined, serverId: string, path: string) {
  const record = getFileSave(scope, serverId, path);
  if (!scope || !record || record.status === 'pending') return;
  queryClient.setQueryData<readonly FileSaveRecord[]>(scope, (current) =>
    current?.filter((candidate) => candidate.id !== record.id),
  );
}

/** One explicit attempt, with the editor's captured revision; no replay after a lost response. */
export async function submitFileSave(
  scope: FileSaveScope,
  input: FileSaveInput,
): Promise<{ revision: string }> {
  if (getFileSave(scope, input.serverId, input.path)?.status === 'pending')
    throw new Error('file_save_pending');
  let resolveCompletion!: (result: { revision: string }) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<{ revision: string }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // A new editor may subscribe after navigating back; the original caller still receives errors.
  void completion.catch(() => {});
  const record: FileSaveRecord = {
    ...input,
    id: crypto.randomUUID(),
    submittedContent: input.content,
    completion,
    status: 'pending',
  };
  queryClient.setQueryData<readonly FileSaveRecord[]>(scope, (current = empty) => [
    ...current.filter(
      (candidate) => candidate.serverId !== input.serverId || candidate.path !== input.path,
    ),
    record,
  ]);
  // An identity change can remove/recreate the same key while HTTP is still in flight.
  const entry = queryClient.getQueryCache().find({ queryKey: scope, exact: true });
  const currentAttempt = () =>
    queryClient.getQueryCache().find({ queryKey: scope, exact: true }) === entry &&
    getFileSave(scope, input.serverId, input.path)?.id === record.id;
  try {
    const result = await api<{ revision: string }>(
      `/v1/servers/${encodeURIComponent(input.serverId)}/files/editor`,
      {
        method: 'PUT',
        body: {
          path: input.path,
          content: input.content,
          expectedRevision: input.expectedRevision,
        },
      },
    );
    if (currentAttempt()) {
      queryClient.setQueryData<readonly FileSaveRecord[]>(scope, (current) =>
        current?.filter((candidate) => candidate.id !== record.id),
      );
      const directory = input.path.includes('/')
        ? input.path.slice(0, input.path.lastIndexOf('/'))
        : '';
      void queryClient.invalidateQueries({
        queryKey: ['files', input.serverId, directory],
      });
    }
    resolveCompletion(result);
    return result;
  } catch (error) {
    if (currentAttempt())
      queryClient.setQueryData<readonly FileSaveRecord[]>(scope, (current) =>
        current?.map((candidate) =>
          candidate.id === record.id ? { ...candidate, status: 'error', error } : candidate,
        ),
      );
    rejectCompletion(error);
    throw error;
  }
}
