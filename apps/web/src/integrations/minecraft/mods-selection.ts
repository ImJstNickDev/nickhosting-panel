import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createMinecraftModsController,
  type MinecraftModRoot,
  type MinecraftModSelection,
  type MinecraftModsSnapshot,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { idempotencyKey, queryClient } from '../../api/client.js';
import { gameUiClient } from '../../features/integrations.js';

export const modsController = createMinecraftModsController(gameUiClient);
export const modsQueryKey = (serverId: string) => ['minecraft-mods', serverId] as const;

/**
 * Coalesce quick selections, serialize writes, and freeze a failed submission for
 * explicit retry with the same key. Aborting a fetch never pretends to cancel staging.
 */
export function useModsSelection(serverId: string, snapshot: MinecraftModsSnapshot | undefined) {
  const [roots, setRoots] = useState<MinecraftModRoot[]>(snapshot?.roots ?? []);
  const [preferBeta, setPreferBeta] = useState(snapshot?.preferBeta ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const alive = useRef(true);
  const revision = useRef(snapshot?.revision ?? -1);
  const state = useRef({
    roots: snapshot?.roots ?? [],
    preferBeta: snapshot?.preferBeta ?? false,
    generation: 0,
    saved: 0,
    busy: false,
    failed: false,
    frozen: undefined as { generation: number; input: MinecraftModSelection } | undefined,
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!snapshot || saving) return;
    const current = state.current;
    if (current.busy || current.failed || current.generation !== current.saved) return;
    if (snapshot.revision < revision.current) return;
    revision.current = snapshot.revision;
    current.roots = snapshot.roots;
    current.preferBeta = snapshot.preferBeta;
    setRoots(current.roots);
    setPreferBeta(snapshot.preferBeta);
    // Refetch can finish while drain is still busy. Adopt it when saving settles,
    // without overwriting a newer edit, a failed intent, or a newer revision.
  }, [snapshot, saving]);
  const drain = useCallback(async () => {
    const current = state.current;
    if (current.busy) return;
    current.busy = true;
    current.failed = false;
    if (alive.current) {
      setSaving(true);
      setError(undefined);
    }
    try {
      do {
        while (current.saved !== current.generation) {
          const submission = current.frozen ?? {
            generation: current.generation,
            input: {
              roots: current.roots.map((root) => ({
                ...root,
                optionalProjectIds: [...root.optionalProjectIds],
              })),
              preferBeta: current.preferBeta,
              idempotencyKey: idempotencyKey(),
            },
          };
          current.frozen = submission;
          const result = await modsController.select(serverId, submission.input);
          revision.current = Math.max(revision.current, result.revision);
          current.saved = submission.generation;
          current.frozen = undefined;
        }
        await queryClient.invalidateQueries({ queryKey: modsQueryKey(serverId) });
        // A new click can arrive while the snapshot refresh is in flight.
      } while (current.saved !== current.generation);
    } catch (failure) {
      current.failed = true;
      if (alive.current) setError(failure);
    } finally {
      current.busy = false;
      if (alive.current) setSaving(false);
    }
  }, [serverId]);
  function change(
    next: MinecraftModRoot[] | ((value: MinecraftModRoot[]) => MinecraftModRoot[]),
    beta = state.current.preferBeta,
  ) {
    const current = state.current;
    current.roots = typeof next === 'function' ? next(current.roots) : next;
    current.preferBeta = beta;
    current.generation++;
    setRoots(current.roots);
    setPreferBeta(beta);
    // An unresolved request keeps its original idempotency identity until explicit recovery.
    if (!current.failed) void drain();
  }
  return {
    roots,
    preferBeta,
    saving,
    error,
    change,
    setPreferBeta: (value: boolean) => change(state.current.roots, value),
    retry: () => void drain(),
  };
}
