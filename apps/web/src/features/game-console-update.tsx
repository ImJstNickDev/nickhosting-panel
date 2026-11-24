import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { OpenworldUpdateProgress } from '../integrations/openworld/version-progress.js';
import {
  isActive,
  updateKey,
  useOpenworldUpdate,
} from '../integrations/openworld/version-update.api.js';
import { availableGameSections } from './integrations.js';
import { ObservedCompletion } from './provisioning.js';
import type { ServerInfo } from './service-contracts.js';

/** Console contributions follow the installed game's declared section and access rules. */
export function useGameConsoleUpdate(
  serverId: string,
  server?: ServerInfo,
  provisioningId?: string,
) {
  const t = useT();
  const section =
    server && availableGameSections(server).find((s) => s.renderer === 'openworld-version');
  const state = useOpenworldUpdate(serverId, Boolean(section), server?.activeOperationId);
  const current = state.current;
  const matches = Boolean(current && current.id === provisioningId);
  const active = isActive(current);
  const observed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (active) observed.current = current?.id;
  }, [active, current?.id]);
  const showProgress =
    active || (current?.phase === 'failed' && (matches || current.id === observed.current));
  const catalog = state.catalog.data;
  const latest = catalog?.latestVersion;
  const hasUpdate =
    latest &&
    latest !== catalog?.installedVersion &&
    !(current?.phase === 'completed' && current.toVersion === latest);
  const label = t(state.error ? 'provisioning.refreshFailed' : updateKey('available'));
  return {
    active,
    ownsProvisioning: matches,
    progress:
      showProgress && current ? (
        <OpenworldUpdateProgress
          serverId={serverId}
          current={current}
          error={state.statusError}
          retry={state.retry}
        />
      ) : undefined,
    completion: section && (
      <ObservedCompletion
        jobId={current?.id}
        state={active ? 'active' : current?.phase}
        label={t(updateKey('completed'))}
      />
    ),
    runtimeAction:
      section && (hasUpdate || state.error) ? (
        <Tooltip content={label}>
          <Link
            to={`/servers/${serverId}/game/${section.id}`}
            className="console-summary-address-edit"
            aria-label={label}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path
                d={
                  state.error
                    ? 'M12 7v6m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'
                    : 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4'
                }
              />
            </svg>
          </Link>
        </Tooltip>
      ) : undefined,
  };
}
