import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { consumeWorldsStream } from '../../../../../games/satisfactory/src/ui/worlds-stream.js';
import type { SatisfactoryWorldsStreamEvent } from '../../../../../games/satisfactory/src/worlds-stream.js';
import { apiError, apiStream } from '../../api/client.js';

type SaveEvent = Extract<SatisfactoryWorldsStreamEvent, { type: 'save' }>;
export type WorldSave = SaveEvent['save'] & { safety?: SaveEvent['safety'] };
export type WorldSession = { sessionName: string; saveHeaders: WorldSave[] };
type StateEvent = Extract<SatisfactoryWorldsStreamEvent, { type: 'state' }>;
export type WorldsView = {
  sessions: WorldSession[];
  currentSessionIndex: number;
  observedAt?: number;
  source?: 'cache' | 'live';
  phase: StateEvent['phase'];
  configured: boolean;
  known: boolean;
};
const empty = (): WorldsView => ({
  sessions: [],
  currentSessionIndex: -1,
  phase: 'refreshing',
  configured: true,
  known: false,
});

/** A stable committed snapshot survives runtime changes and interrupted refreshes.
 * Draft batches copy only changed sessions, at most once per animation interval. */
export function useWorldsStream(serverId: string, runtimeState: string, poll: boolean) {
  const saved = useRef({ serverId, view: empty() });
  if (saved.current.serverId !== serverId) saved.current = { serverId, view: empty() };
  const [display, setDisplay] = useState(saved.current);
  const view = display.serverId === serverId ? display.view : saved.current.view;
  const query = useQuery({
    queryKey: ['satisfactory-worlds', serverId, runtimeState],
    refetchInterval: poll || view.phase === 'starting' ? 3000 : false,
    queryFn: async ({ signal }) => {
      let committed = saved.current.view;
      let next = { ...committed, phase: 'refreshing' as StateEvent['phase'] };
      let draft: WorldSession[] | undefined;
      let complete = true;
      const pending = new Map<number, WorldSave[]>();
      const pendingSafety = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const publish = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (signal.aborted) return;
        if (draft) {
          for (const [index, saves] of pending) {
            const session = draft[index];
            if (session)
              draft[index] = { ...session, saveHeaders: [...session.saveHeaders, ...saves] };
          }
          pending.clear();
          if (pendingSafety.size > 0) {
            draft = draft.map((session) => ({
              ...session,
              saveHeaders: session.saveHeaders.map((save) =>
                pendingSafety.has(save.saveName) ? { ...save, safety: true } : save,
              ),
            }));
            pendingSafety.clear();
          }
          const sessions = [...committed.sessions];
          draft.forEach((session, index) => {
            sessions[index] = session;
          });
          next = { ...next, sessions };
        }
        setDisplay({ serverId, view: { ...next } });
      };
      const schedule = () => {
        timer ??= setTimeout(publish, 50);
      };
      try {
        const stream = await apiStream(
          `/v1/servers/${encodeURIComponent(serverId)}/satisfactory/api/worlds/stream`,
          { signal },
        );
        await consumeWorldsStream(stream, signal, (event) => {
          switch (event.type) {
            case 'state':
              if (draft && event.phase !== 'refreshing' && event.phase !== 'ready') {
                draft = undefined;
                pending.clear();
                pendingSafety.clear();
                complete = true;
                next = { ...committed, source: committed.known ? 'cache' : undefined };
              }
              next = { ...next, phase: event.phase, configured: event.configured };
              publish();
              break;
            case 'begin':
              draft = [];
              pending.clear();
              pendingSafety.clear();
              complete = false;
              next = { ...next, source: event.source, observedAt: event.observedAt };
              break;
            case 'session':
              if (!draft) throw new Error('invalid_worlds_sequence');
              draft[event.index] = { sessionName: event.sessionName, saveHeaders: [] };
              schedule();
              break;
            case 'save': {
              if (!draft?.[event.sessionIndex]) throw new Error('invalid_worlds_sequence');
              const saves = pending.get(event.sessionIndex) ?? [];
              saves.push({ ...event.save, ...(event.safety ? { safety: event.safety } : {}) });
              pending.set(event.sessionIndex, saves);
              schedule();
              break;
            }
            case 'classification':
              for (const name of event.saveNames) pendingSafety.add(name);
              schedule();
              break;
            case 'complete':
              publish();
              next = {
                ...next,
                sessions: draft ?? [],
                source: event.source,
                currentSessionIndex: event.currentSessionIndex,
                observedAt: event.observedAt,
                known: true,
              };
              draft = undefined;
              complete = true;
              committed = next;
              saved.current = { serverId, view: committed };
              publish();
              break;
            case 'error':
              throw apiError(event);
          }
        });
        if (!complete) throw new Error('incomplete_worlds_stream');
        return true;
      } catch (error) {
        if (!signal.aborted) {
          next = {
            ...committed,
            phase: 'unavailable',
            source: committed.known ? 'cache' : undefined,
          };
          draft = undefined;
          pending.clear();
          publish();
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  });
  return { ...query, view };
}
