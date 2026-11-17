import type { ReactNode } from 'react';
import './ficsit.css';

/** Shared FICSIT framing for integration screens. */
export function FicsitHeader({
  title,
  source,
  live = false,
}: {
  title: string;
  source?: ReactNode;
  live?: boolean;
}) {
  return (
    <header className="ficsit-header">
      <h2>{title}</h2>
      {source && <span className={`ficsit-source${live ? ' live' : ''}`}>{source}</span>}
    </header>
  );
}
export function FicsitUpdated({ children }: { children: ReactNode }) {
  return <footer className="ficsit-updated">{children}</footer>;
}
