import { type RefObject, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import type { AtlasController, AtlasMode } from './atlas-types.js';
import { createMapDebugRecorder, type MapDebugRecorder } from './map-debug-recorder.js';
import { MapFps } from './map-fps.js';
import { mapBase, mapKey } from './map-query.js';

export function MapDebugStats({
  serverId,
  world,
  processRef,
  face,
  scene,
  mode,
  recorder,
  frames,
}: {
  serverId: string;
  world: string;
  processRef: string;
  face: number;
  scene: RefObject<AtlasController | null>;
  mode: RefObject<AtlasMode>;
  recorder: RefObject<MapDebugRecorder | null>;
  frames: RefObject<number | null>;
}) {
  const t = useT();
  const [trace, setTrace] = useState<string | false>();
  useEffect(() => {
    setTrace(undefined);
    const traceId = crypto.randomUUID();
    const active = createMapDebugRecorder(
      () => {
        const engine = scene.current;
        return (
          engine && {
            frame: engine.getView(),
            mode: mode.current,
            terrain: engine.getDebugTerrain(),
          }
        );
      },
      (batch, samples, signal, final) =>
        api<{ recorded: false } | undefined>(`${mapBase(serverId)}/debug-telemetry`, {
          body: { traceId, batch, world, processRef, face, samples },
          signal,
          keepalive: final,
        }).then((reply) => reply === undefined),
      (failed) => setTrace(failed ? false : traceId.slice(0, 8)),
    );
    function sync() {
      if (document.hidden) {
        if (recorder.current === active) active.pause();
        recorder.current = null;
      } else {
        recorder.current = active;
        active.sample();
      }
    }
    sync();
    const timer = window.setInterval(() => recorder.current?.sample(), 500);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
      recorder.current = null;
      active.stop(!document.hidden);
    };
  }, [serverId, world, processRef, face, scene, mode, recorder]);
  return (
    <MapFps
      frames={frames}
      trace={trace || undefined}
      detail={
        trace === undefined
          ? undefined
          : t(mapKey(trace === false ? 'atlas.recordFailed' : 'atlas.recording'))
      }
    />
  );
}
