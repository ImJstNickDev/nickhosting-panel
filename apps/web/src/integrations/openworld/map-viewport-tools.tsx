import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { mapKey as k } from './map-query.js';
import './atlas-controls.css';

const paths = {
  out: 'M5 12h14',
  in: 'M5 12h14m-7-7v14',
  center:
    'M12 2v4m0 12v4M2 12h4m12 0h4m-3 0a7 7 0 1 1-14 0 7 7 0 1 1 14 0m-5.5 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0',
  extent: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5m4-2 3-5 5 7H7z',
  full: 'M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6',
  exit: 'M9 3v6H3m18 0h-6V3m0 18v-6h6M3 15h6v6',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0m-12-2a3 3 0 1 1 5 2.2c-1.4 1-2 1.3-2 2.5m0 2.1v.1',
} as const;

function ToolIcon({ icon }: { icon: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[icon]} />
    </svg>
  );
}

function Tool({
  icon,
  label,
  onClick,
  pressed,
}: {
  icon: keyof typeof paths;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
      <ToolIcon icon={icon} />
    </button>
  );
}

export function ViewportTools({
  zoom,
  center,
  fit,
  fullscreen,
  toggleFullscreen,
  children,
}: {
  zoom: (factor: number) => void;
  center: () => void;
  fit?: () => void;
  fullscreen?: boolean;
  toggleFullscreen?: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="ow-viewport-tools">
      <Tool icon="out" label={t(k('zoomOut'))} onClick={() => zoom(0.5)} />
      <Tool icon="in" label={t(k('zoomIn'))} onClick={() => zoom(2)} />
      <Tool icon="center" label={t(k('recenter'))} onClick={center} />
      {fit && <Tool icon="extent" label={t(k('showAllTerrain'))} onClick={fit} />}
      {toggleFullscreen && (
        <Tool
          icon={fullscreen ? 'exit' : 'full'}
          label={t(k(fullscreen ? 'atlas.exitFull' : 'atlas.full'))}
          pressed={fullscreen}
          onClick={toggleFullscreen}
        />
      )}
      <details
        className="ow-viewport-help"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }}
      >
        <summary aria-label={t(k('atlas.controls'))} title={t(k('atlas.controls'))}>
          <ToolIcon icon="help" />
        </summary>
        <div className="ow-map-key ow-viewport-legend">{children}</div>
      </details>
    </div>
  );
}
