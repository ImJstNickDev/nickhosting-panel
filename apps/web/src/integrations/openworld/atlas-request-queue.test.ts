import { expect, it } from 'vitest';
import { AtlasRequestQueue, type AtlasTask } from './atlas-request-queue.js';
import { backgroundPriority } from './atlas-turn-plan.js';

it('admits missing coverage first and gives each other lane a turn even under continual replanning', () => {
  const queue = new AtlasRequestQueue();
  const base: AtlasTask = {
    key: 'base',
    request: { kind: 'surface', ci: 0, cj: 0, n: 8, lod: 6 },
    priority: 18,
  };
  const refine: AtlasTask = {
    ...base,
    key: 'refine',
    request: { kind: 'surface', ci: 0, cj: 0, n: 4, lod: 2 },
    priority: 10,
  };
  const mesh: AtlasTask = {
    key: 'mesh',
    request: { kind: 'mesh', i: 1, j: 1, lod: 1 },
    priority: -1,
  };
  const rear: AtlasTask = { ...base, key: 'rear', priority: backgroundPriority };
  const admissions: string[] = [];
  for (let admission = 0; admission < 16; admission++) {
    // A new camera frame replaces all four live queues between every completion.
    queue.replace([mesh, refine, rear, base]);
    admissions.push(queue.admissions(() => true)()?.key ?? '');
  }
  expect(admissions[0]).toBe('base');
  for (const start of [0, 8]) {
    const window = admissions.slice(start, start + 8);
    expect(window.filter((k) => k === 'base')).toHaveLength(3);
    expect(window.filter((k) => k === 'mesh')).toHaveLength(2);
    expect(window.filter((k) => k === 'refine')).toHaveLength(2);
    expect(window.filter((k) => k === 'rear')).toHaveLength(1);
  }
});
