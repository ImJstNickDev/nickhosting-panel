import type {
  OpenworldMapDebugOutcomes,
  OpenworldMapDebugSample,
  OpenworldMapDebugTerrain,
} from '../../../../../games/openworld/src/map-debug.js';
import type { AtlasFrame, AtlasMode } from './atlas-types.js';

export type MapDebugRecorder = ReturnType<typeof createMapDebugRecorder>;

const outcomes = () => ({ ok: 0, empty: 0, aborted: 0, conflict: 0, failed: 0 });
const degrees = (radians: number) => (radians * 180) / Math.PI;
const wrap = (radians: number) => Math.atan2(Math.sin(radians), Math.cos(radians));

/** Eight half-second samples per report. On a slow/offline link keep only the latest four seconds. */
export function createMapDebugRecorder(
  read: () => { frame: AtlasFrame; mode: AtlasMode; terrain: OpenworldMapDebugTerrain } | null,
  send: (
    batch: number,
    samples: OpenworldMapDebugSample[],
    signal: AbortSignal,
    final: boolean,
  ) => Promise<boolean>,
  reportError: (failed: boolean) => void,
  now = () => performance.now(),
) {
  const start = now();
  let nextSend = start;
  let sequence = 0;
  let previousYaw: number | undefined;
  let turn = 0;
  let draws = 0;
  let previous = '';
  let terrainRequests = outcomes();
  let meshRequests = outcomes();
  let buffer: OpenworldMapDebugSample[] = [];
  let pending = false;
  let paused = false;
  let consecutiveFailures = 0;
  const controller = new AbortController();
  function camera(yaw: number) {
    if (previousYaw !== undefined) turn += Math.abs(wrap(yaw - previousYaw));
    previousYaw = yaw;
  }
  function capture() {
    if (controller.signal.aborted) return;
    const state = read();
    if (!state) return;
    const { frame, mode, terrain } = state;
    camera(frame.yaw);
    const sample = {
      mode,
      columnX: Math.floor((frame.flight?.eyeX ?? frame.x) / 16),
      columnZ: Math.floor((frame.flight?.eyeZ ?? frame.z) / 16),
      spanMeters: Math.round(frame.span),
      eyeHeightMeters: frame.flight ? Math.round(frame.flight.eyeY) : null,
      yawDegrees: Math.round(degrees(wrap(frame.yaw))),
      pitchDegrees: frame.flight ? Math.round(degrees(frame.flight.pitch)) : null,
      turnDegrees: Math.round(degrees(turn)),
      draws,
      terrain,
      terrainRequests,
      meshRequests,
    };
    terrainRequests = outcomes();
    meshRequests = outcomes();
    turn = 0;
    draws = 0;
    const signature = JSON.stringify(sample);
    const time = now();
    if (
      signature !== previous ||
      sample.turnDegrees > 0 ||
      sample.draws > 0 ||
      Object.values(sample.terrainRequests).some(Boolean) ||
      Object.values(sample.meshRequests).some(Boolean)
    ) {
      buffer.push({ ...sample, ms: Math.min(0x7fffffff, Math.round(time - start)) });
      if (buffer.length > 8) buffer.shift();
      previous = signature;
    }
  }
  function finish() {
    if (controller.signal.aborted || consecutiveFailures > 0) return;
    capture();
    if (!buffer.length) return;
    const samples = buffer;
    buffer = [];
    // Browsers can hide/unload the page between periodic batches. This last, bounded report
    // belongs to the active recording; it is never retried after teardown.
    void send(sequence++, samples, AbortSignal.timeout(5000), true).catch(() => {});
  }
  return {
    request(kind: 'mesh' | 'surface', outcome: keyof OpenworldMapDebugOutcomes) {
      if (!paused && !controller.signal.aborted)
        (kind === 'mesh' ? meshRequests : terrainRequests)[outcome]++;
    },
    draw(yaw: number) {
      if (paused || controller.signal.aborted) return;
      camera(yaw);
      draws++;
    },
    sample() {
      if (controller.signal.aborted) return;
      paused = false;
      capture();
      const time = now();
      if (pending || buffer.length === 0 || time < nextSend) return;
      const samples = buffer;
      buffer = [];
      nextSend = time + 4000;
      pending = true;
      void send(sequence++, samples, controller.signal, false)
        .then((recorded) => {
          if (controller.signal.aborted) return;
          consecutiveFailures = 0;
          reportError(!recorded);
          if (!recorded) controller.abort();
        })
        .catch((error: { status?: number; retryAfterSeconds?: number } | null) => {
          if (controller.signal.aborted) return;
          reportError(true);
          if ([401, 403, 404, 409].includes(error?.status ?? 0)) {
            controller.abort();
            return;
          }
          consecutiveFailures++;
          const cooldown = Math.max(
            Math.min(60_000, 4000 * 2 ** consecutiveFailures),
            (error?.retryAfterSeconds ?? 0) * 1000,
          );
          nextSend = now() + cooldown;
          previous = ''; // An idle scene still gets one fresh report after recovery.
        })
        .finally(() => {
          pending = false;
        });
    },
    pause() {
      if (!paused) finish();
      paused = true;
      previousYaw = undefined;
      terrainRequests = outcomes();
      meshRequests = outcomes();
      draws = 0;
      turn = 0;
      buffer = [];
      previous = '';
    },
    stop(visible: boolean) {
      if (visible) finish();
      controller.abort();
      buffer = [];
    },
  };
}
