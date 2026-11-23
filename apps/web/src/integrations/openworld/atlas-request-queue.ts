import { backgroundPriority } from './atlas-turn-plan.js';
import type { AtlasRequest } from './atlas-types.js';

export type AtlasTask = { key: string; request: AtlasRequest; priority: number };
type Lane = 'coverage' | 'mesh' | 'detail' | 'prepare';

function laneFor(task: AtlasTask): Lane {
  if (task.priority >= backgroundPriority) return 'prepare';
  if (task.request.kind === 'mesh') return 'mesh';
  return task.request.kind === 'surface' && task.request.lod === 6 ? 'coverage' : 'detail';
}

// Missing coarse terrain leads on entry. Share subsequent admissions so a moving
// camera cannot perpetually push native detail or the next turn out of the queue.
const schedule: readonly Lane[] = [
  'coverage',
  'mesh',
  'detail',
  'coverage',
  'mesh',
  'detail',
  'coverage',
  'prepare',
];
const fallback: readonly Lane[] = ['coverage', 'mesh', 'detail', 'prepare'];

export class AtlasRequestQueue {
  private readonly lanes: Record<Lane, Set<AtlasTask>> = {
    coverage: new Set(),
    mesh: new Set(),
    detail: new Set(),
    prepare: new Set(),
  };
  private turn = 0;

  replace(tasks: AtlasTask[]) {
    this.clear();
    for (const task of tasks.sort((a, b) => a.priority - b.priority))
      this.lanes[laneFor(task)].add(task);
  }
  clear() {
    for (const lane of fallback) this.lanes[lane].clear();
  }
  delete(task: AtlasTask) {
    this.lanes[laneFor(task)].delete(task);
  }
  *[Symbol.iterator]() {
    for (const lane of fallback) yield* this.lanes[lane];
  }
  meshes(background: boolean) {
    return this.lanes[background ? 'prepare' : 'mesh'];
  }

  // Reuse each lane's iterator throughout a dispatch. A blocked mesh group
  // should not make the next surface scan every other queued voxel column.
  admissions(
    eligible: (task: AtlasTask) => boolean,
    available: (lane: Lane) => boolean = () => true,
  ) {
    const iterators = {
      coverage: this.lanes.coverage.values(),
      mesh: this.lanes.mesh.values(),
      detail: this.lanes.detail.values(),
      prepare: this.lanes.prepare.values(),
    };
    const take = (lane: Lane) => {
      if (!available(lane)) return undefined;
      for (const task of iterators[lane]) if (eligible(task)) return task;
      return undefined;
    };
    return () => {
      const preferred = schedule[this.turn] ?? 'coverage';
      let next = take(preferred);
      for (const lane of fallback) {
        if (next) break;
        if (lane !== preferred) next = take(lane);
      }
      if (next) this.turn = (this.turn + 1) % schedule.length;
      return next;
    };
  }
}
