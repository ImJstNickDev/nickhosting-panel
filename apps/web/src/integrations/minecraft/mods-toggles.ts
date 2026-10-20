import { useMutation, useMutationState } from '@tanstack/react-query';
import type { MinecraftModsSnapshot } from '../../../../../games/minecraft/src/mod-contracts.js';
import { ApiError, idempotencyKey, queryClient } from '../../api/client.js';
import { modsController, modsQueryKey } from './mods-selection.js';

type Pack = MinecraftModsSnapshot['packs'][number];
type Toggle = { path: string; action: 'enable' | 'disable'; idempotencyKey: string };
export const modFileIdentity = (path: string) => path.replace(/\.disabled$/, '');
const destination = (input: Toggle) =>
  `${modFileIdentity(input.path)}${input.action === 'disable' ? '.disabled' : ''}`;

function uncertain(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    error.code === 'operation_uncertain' ||
    error.status === 0 ||
    error.status >= 500
  );
}
function changedPack(pack: Pack, input: Toggle): Pack {
  if (modFileIdentity(pack.path) !== modFileIdentity(input.path)) return pack;
  const path = destination(input);
  return {
    ...pack,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    state: input.action === 'disable' ? 'disabled' : 'enabled',
  };
}

/** Pending intents live in QueryClient, so changing tabs does not cancel a rename. */
export function useModsToggles(serverId: string, snapshot: MinecraftModsSnapshot | undefined) {
  const mutationKey = ['minecraft-mod-toggle', serverId];
  const mutation = useMutation({
    mutationKey,
    // Rapid clicks on different rows remain responsive without competing for Fileman's lock.
    scope: { id: `minecraft-mod-toggle:${serverId}` },
    mutationFn: async (input: Toggle) => {
      const result = await modsController.toggle(serverId, input);
      if (result.state !== 'published')
        throw new ApiError('operation_uncertain', 'errors.operation_uncertain');
      return result;
    },
    onSuccess: async (_result, input) => {
      // A pre-publication inventory response must not undo the confirmed rename.
      await queryClient.cancelQueries({ queryKey: modsQueryKey(serverId) });
      queryClient.setQueryData<MinecraftModsSnapshot>(modsQueryKey(serverId), (current) =>
        current
          ? {
              ...current,
              packs: current.packs.map((pack) => changedPack(pack, input)),
              changes: current.changes.filter(
                (change) =>
                  !change.immediate || modFileIdentity(change.path) !== modFileIdentity(input.path),
              ),
              restart: { required: true },
            }
          : current,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: modsQueryKey(serverId) });
      void queryClient.invalidateQueries({ queryKey: ['minecraft-mods-restart', serverId] });
    },
  });
  const states = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      input: entry.state.variables as Toggle,
      status: entry.state.status,
      error: entry.state.error,
    }),
  });
  const latest = new Map(
    states
      .filter((entry) => entry.input)
      .map((entry) => [modFileIdentity(entry.input.path), entry]),
  );
  const pending = [...latest.values()].filter((entry) => entry.status === 'pending');
  const failure = [...latest.values()].find((entry) => entry.status === 'error');
  const immediate = snapshot?.changes.filter((change) => change.immediate) ?? [];
  const interrupted = immediate.some(
    (change) =>
      !pending.some((entry) => modFileIdentity(entry.input.path) === modFileIdentity(change.path)),
  );
  const locked = (path: string) => {
    const entry = latest.get(modFileIdentity(path));
    return (
      entry?.status === 'pending' ||
      (entry?.status === 'error' && uncertain(entry.error)) ||
      immediate.some((change) => modFileIdentity(change.path) === modFileIdentity(path))
    );
  };
  const optimistic = [...latest.values()].filter(
    (entry) => entry.status === 'pending' || (entry.status === 'error' && uncertain(entry.error)),
  );
  const data = snapshot
    ? {
        ...snapshot,
        changes: snapshot.changes.filter((change) => !change.immediate),
        packs: snapshot.packs.map((pack) => {
          const input = optimistic.find(
            (entry) => modFileIdentity(entry.input.path) === modFileIdentity(pack.path),
          )?.input;
          // Only the visible state is speculative; retain the observed filename until confirmed.
          return input
            ? {
                ...pack,
                state: input.action === 'disable' ? ('disabled' as const) : ('enabled' as const),
              }
            : pack;
        }),
      }
    : undefined;
  return {
    data,
    locked,
    pending: pending.length > 0,
    error:
      failure?.error ??
      (interrupted ? new ApiError('operation_uncertain', 'errors.operation_uncertain') : undefined),
    toggle(pack: Pack, action: Toggle['action']) {
      if (locked(pack.path)) return;
      // Also guard same-tick duplicate events before React has rendered the pending state.
      if (
        queryClient
          .getMutationCache()
          .findAll({ mutationKey, status: 'pending' })
          .some(
            (entry) =>
              modFileIdentity((entry.state.variables as Toggle).path) ===
              modFileIdentity(pack.path),
          )
      )
        return;
      mutation.mutate({ path: pack.path, action, idempotencyKey: idempotencyKey() });
    },
    async retry() {
      if (pending.length) return;
      if (interrupted) await modsController.recover(serverId);
      if (failure) mutation.mutate(failure.input);
      else void queryClient.invalidateQueries({ queryKey: modsQueryKey(serverId) });
    },
  };
}
