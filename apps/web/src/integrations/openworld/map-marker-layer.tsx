import { type ReactNode, useMemo, useState } from 'react';
import { useT } from '../../app/i18n.js';
import type { AtlasController, AtlasFrame } from './atlas-types.js';
import { mapKey as k } from './map-query.js';

export type AtlasMarker = {
  id: string | number;
  x: number;
  z: number;
  y?: number;
  name: string;
  element: ReactNode;
  selected?: boolean;
};
type Group = { markers: [AtlasMarker, ...AtlasMarker[]]; x: number; z: number };

// Keep the entire layer searchable and retain separate selected points.
// At wide scales one button represents markers which would overlap on screen.
export function MapMarkerLayer({
  markers,
  frame,
  scene,
}: {
  markers: AtlasMarker[];
  frame?: AtlasFrame;
  scene: React.RefObject<AtlasController | null>;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState('');
  const sorted = useMemo(
    () => (markers.length > 48 ? [...markers].sort((a, b) => a.x - b.x) : markers),
    [markers],
  );
  const groups = useMemo(() => {
    if (sorted.length <= 48 || !frame) return null;
    const { i0, i1, j0, j1 } = frame.bounds;
    const size = 2 ** Math.ceil(Math.log2(Math.max(0.25, (28 * frame.span) / frame.width)));
    const bins = new Map<string, Group>();
    let left = 0,
      right = sorted.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if ((sorted[mid]?.x ?? Infinity) < i0 * 16) left = mid + 1;
      else right = mid;
    }
    for (let i = left; i < sorted.length; i++) {
      const p = sorted[i];
      if (!p) continue;
      if (p.x >= (i1 + 1) * 16) break;
      if (p.z < j0 * 16 || p.z >= (j1 + 1) * 16) continue;
      const key = p.selected
        ? `selected:${p.id}`
        : [size, Math.floor(p.x / size), Math.floor(p.z / size)].join('/');
      const group = bins.get(key);
      if (group) {
        group.markers.push(p);
        group.x += p.x;
        group.z += p.z;
      } else bins.set(key, { markers: [p], x: p.x, z: p.z });
    }
    return bins;
  }, [sorted, frame]);
  if (!groups) return <>{markers.map((p) => p.element)}</>;
  const chosen = groups.get(expanded);
  return (
    <>
      {Array.from(groups, ([key, g]) => {
        const count = g.markers.length;
        if (count === 1) return g.markers[0].element;
        const x = g.x / count,
          z = g.z / count;
        return (
          <button
            className="ow-map-cluster"
            key={key}
            type="button"
            data-x={x}
            data-z={z}
            aria-label={t(k('atlas.cluster'), { count })}
            onClick={() => {
              const engine = scene.current;
              if (!engine) return;
              const span = engine.getView().span;
              const first = g.markers[0];
              if (
                span <= 8 ||
                g.markers.every((p) => Math.abs(p.x - first.x) + Math.abs(p.z - first.z) < 0.01)
              )
                setExpanded(key);
              else engine.setView({ x, z, span: Math.max(4, span / 3) });
            }}
          >
            {count}
          </button>
        );
      })}
      {chosen && (
        <div className="ow-map-cluster-list">
          <button
            type="button"
            className="secondary"
            aria-label={t('web.close')}
            onClick={() => setExpanded('')}
          >
            ×
          </button>
          {chosen.markers.map((p) => (
            <div key={p.id}>
              {p.element}
              <span>{p.name}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
