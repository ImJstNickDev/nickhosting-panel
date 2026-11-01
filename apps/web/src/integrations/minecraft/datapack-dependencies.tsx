import type { MinecraftDatapackCatalogPlan } from '@nickhosting/minecraft/ui';
import { useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Dialog } from '../../components/ui.js';

const key = (name: string) => `games.minecraft.datapacks.dependencies.${name}`;

export function DatapackDependencies({
  name,
  plan,
  selectedOptional,
  busy,
  onClose,
  onPrepare,
}: {
  name: string;
  plan: MinecraftDatapackCatalogPlan;
  selectedOptional: string[];
  busy: boolean;
  onClose(): void;
  onPrepare(optional: string[], disablePaths: string[]): void;
}) {
  const t = useT();
  const [selected, setSelected] = useState(selectedOptional);
  const changed =
    selected.length !== selectedOptional.length ||
    selected.some((id) => !selectedOptional.includes(id));
  return (
    <Dialog open title={name} onClose={onClose} closeIcon className="datapack-dependencies">
      {plan.blockers.length > 0 && (
        <div className="datapack-dependency-blockers" role="status">
          {plan.blockers.map((blocker) => (
            <p key={`${blocker.projectId}:${blocker.reason}`}>
              <strong>{blocker.name}</strong>
              <span>{t(key(`blocker.${blocker.reason}`))}</span>
            </p>
          ))}
        </div>
      )}
      {plan.items.length > 0 && (
        <ul className="datapack-dependency-items">
          {plan.items.map((item) => (
            <li key={`${item.provider}:${item.projectId}`}>
              <span>
                <strong>{item.name}</strong>
                {item.dependency && <small>{t(key('dependency'))}</small>}
              </span>
              <span>{t(key(`disposition.${item.disposition}`))}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.optional.length > 0 && (
        <section aria-label={t(key('optional'))}>
          <h3>{t(key('optional'))}</h3>
          <div className="datapack-dependency-options">
            {plan.optional.map((item) => (
              <button
                type="button"
                key={item.projectId}
                disabled={busy}
                aria-pressed={selected.includes(item.projectId)}
                onClick={() =>
                  setSelected((current) =>
                    current.includes(item.projectId)
                      ? current.filter((id) => id !== item.projectId)
                      : [...current, item.projectId],
                  )
                }
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  aria-hidden="true"
                >
                  <path
                    d={selected.includes(item.projectId) ? 'm5 12 4 4L19 6' : 'M12 5v14M5 12h14'}
                  />
                </svg>
                {item.name}
              </button>
            ))}
          </div>
        </section>
      )}
      {plan.conflicts.length > 0 && (
        <section className="datapack-dependency-conflicts" aria-label={t(key('conflicts'))}>
          <h3>{t(key('conflicts'))}</h3>
          <p>{t(key('disableExplanation'))}</p>
          <ul>
            {plan.conflicts.map((item) => (
              <li key={item.path}>
                <strong>{item.name}</strong>
                <small>{item.path}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer>
        <button type="button" disabled={busy} className="secondary" onClick={onClose}>
          {t(key('back'))}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onPrepare(selected, changed ? [] : plan.conflicts.map((item) => item.path))
          }
        >
          {t(
            key(
              changed
                ? 'prepareSelection'
                : plan.blockers.length
                  ? 'retry'
                  : plan.conflicts.length
                    ? 'disableAndPrepare'
                    : 'prepareSelection',
            ),
          )}
        </button>
      </footer>
    </Dialog>
  );
}
