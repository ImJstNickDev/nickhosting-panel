import { useEffect, useId, useRef, useState } from 'react';
import { api, queryClient } from '../api/client.js';
import { useT } from '../app/i18n.js';
import { Dialog, ErrorNotice } from '../components/ui.js';
import { FileDestinationTree } from './file-destination-tree.js';
import { joinFilePath as join, validMoveTarget } from './file-manager-model.js';
import { type ServerFile, serverPath } from './service-contracts.js';
import './file-move-flow.css';

export interface FileMovePlan {
  source: string;
  destination: string;
  names: string[];
}
type Choice = 'overwrite' | 'skip';
type Collision = { name: string; canOverwrite: boolean };
type MoveState = {
  plan: FileMovePlan;
  phase: 'destination' | 'checking' | 'conflict' | 'failed';
  decisions: Record<string, Choice>;
  collisions: Collision[];
  error?: unknown;
  attempted?: boolean;
  identity: string | undefined;
};

export function FileSelectionSummary({ names }: { names: string[] }) {
  const t = useT();
  return (
    <p className="fm-targets fm-selection-summary">
      {names.slice(0, 3).join(', ')}
      {names.length > 3 && <> {t('file.moreItems', { count: names.length - 3 })}</>}
    </p>
  );
}

/** One decision flow for toolbar/context-menu moves and internal drops. */
export function useFileMove(options: {
  serverId: string;
  identity: string | undefined;
  canMutate: boolean;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onComplete: (names: string[]) => void;
}) {
  const t = useT();
  const latest = useRef(options);
  const conflictNameId = useId();
  latest.current = options;
  const [state, setState] = useState<MoveState>();
  const stateRef = useRef(state);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const authority = `${options.serverId}\0${options.identity ?? ''}`;
  const previousAuthority = useRef(authority);
  const dialogBody = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (previousAuthority.current === authority) return;
    previousAuthority.current = authority;
    generation.current++;
    stateRef.current = undefined;
    setState(undefined);
    // Keep the mutation lock until an already-issued request settles. Changing
    // identity cannot turn an uncertain effect into a cancellable/replayable one.
  }, [authority]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  function update(value: MoveState | undefined) {
    stateRef.current = value;
    if (mounted.current) setState(value);
  }
  function setWorking(value: boolean) {
    working.current = value;
    if (mounted.current) {
      setBusy(value);
      latest.current.setBusy(value);
    }
  }
  function close() {
    if (working.current) return;
    generation.current++;
    update(undefined);
    latest.current.onClose();
  }
  function isCurrent(operation: MoveState, version: number) {
    return (
      mounted.current &&
      generation.current === version &&
      operation.identity !== undefined &&
      latest.current.identity === operation.identity &&
      latest.current.serverId === options.serverId &&
      latest.current.canMutate
    );
  }
  async function refresh(plan: FileMovePlan) {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['files', options.serverId, plan.source],
        exact: true,
      }),
      queryClient.invalidateQueries({
        queryKey: ['files', options.serverId, plan.destination],
        exact: true,
      }),
    ]);
  }
  async function inspect(plan: FileMovePlan, decisions: Record<string, Choice>) {
    const names = plan.names.filter((name) => decisions[name] !== 'skip');
    const [sources, destination] = await Promise.all([
      api<ServerFile[]>(
        `${serverPath(options.serverId)}/files?path=${encodeURIComponent(plan.source)}`,
      ),
      api<ServerFile[]>(
        `${serverPath(options.serverId)}/files?path=${encodeURIComponent(plan.destination)}`,
      ),
    ]);
    const collisions: Collision[] = [];
    for (const name of names) {
      const source = sources.find((entry) => entry.name === name);
      if (!source || source.is_symlink) throw { messageKey: 'file.pathNotFound' };
      const targets = destination.filter(
        (entry) => entry.name.toLowerCase() === name.toLowerCase(),
      );
      if (!targets.length) continue;
      const target = targets[0];
      const canOverwrite = Boolean(
        source.is_file &&
          targets.length === 1 &&
          target?.name === name &&
          target.is_file &&
          !target.is_symlink,
      );
      if (decisions[name] !== 'overwrite' || !canOverwrite) collisions.push({ name, canOverwrite });
    }
    return collisions;
  }
  async function execute(operation: MoveState) {
    if (working.current || !latest.current.canMutate) return;
    const version = generation.current;
    if (!isCurrent(operation, version)) return;
    setWorking(true);
    update({ ...operation, phase: 'checking', error: undefined });
    const names = operation.plan.names.filter((name) => operation.decisions[name] !== 'skip');
    let submitted = false;
    try {
      if (names.length) {
        // Revalidate after decisions: new collisions never inherit blanket consent.
        const collisions = await inspect(operation.plan, operation.decisions);
        if (!isCurrent(operation, version)) throw { messageKey: 'errors.forbidden' };
        if (collisions.length) {
          update({ ...operation, phase: 'conflict', collisions, error: undefined });
          return;
        }
        submitted = true;
        const overwrite = names.filter((name) => operation.decisions[name] === 'overwrite');
        await api(`${serverPath(options.serverId)}/files`, {
          method: 'POST',
          body: {
            action: 'rename',
            root: '',
            files: names.map((name) => ({
              from: join(operation.plan.source, name),
              to: join(operation.plan.destination, name),
            })),
            ...(overwrite.length
              ? { overwrite: overwrite.map((name) => join(operation.plan.destination, name)) }
              : {}),
          },
        });
      }
      await refresh(operation.plan);
      if (isCurrent(operation, version)) {
        update(undefined);
        latest.current.onComplete(names);
        setWorking(false);
        latest.current.onClose();
      } else if (mounted.current && generation.current === version) {
        update(undefined);
      }
    } catch (error) {
      if (!isCurrent(operation, version)) {
        if (mounted.current && generation.current === version) update(undefined);
        return;
      }
      if (submitted) {
        await refresh(operation.plan);
        // A proven API preflight conflict may acquire new explicit choices, but
        // a failed/unknown provider effect is never automatically replayed.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'conflict' &&
          isCurrent(operation, version)
        ) {
          try {
            const collisions = await inspect(operation.plan, operation.decisions);
            if (collisions.length && isCurrent(operation, version)) {
              update({ ...operation, phase: 'conflict', collisions, error: undefined });
              return;
            }
          } catch {
            /* Keep the original error and require inspection. */
          }
        }
      }
      if (isCurrent(operation, version))
        update({ ...operation, phase: 'failed', error, attempted: submitted });
    } finally {
      setWorking(false);
    }
  }
  function begin(plan: FileMovePlan, chooseDestination = true) {
    if (!latest.current.canMutate || latest.current.isBusy() || working.current) return;
    generation.current++;
    const next: MoveState = {
      plan,
      phase: chooseDestination ? 'destination' : 'checking',
      decisions: Object.create(null),
      collisions: [],
      identity: latest.current.identity,
    };
    update(next);
    if (!chooseDestination) void execute(next);
  }
  function decide(choice: Choice, all = false) {
    const current = stateRef.current;
    if (current?.phase !== 'conflict' || working.current) return;
    if (!isCurrent(current, generation.current)) return;
    const decisions = Object.assign(Object.create(null), current.decisions) as Record<
      string,
      Choice
    >;
    for (const collision of all ? current.collisions : current.collisions.slice(0, 1)) {
      if (choice === 'skip' || collision.canOverwrite) decisions[collision.name] = choice;
    }
    const collisions = current.collisions.filter(
      (collision) =>
        !decisions[collision.name] ||
        (decisions[collision.name] === 'overwrite' && !collision.canOverwrite),
    );
    const next = { ...current, decisions, collisions };
    if (collisions.length) update(next);
    else void execute(next);
  }
  const currentCollision = state?.collisions[0];
  useEffect(() => {
    if (state?.phase === 'conflict' && currentCollision?.name)
      dialogBody.current?.querySelector<HTMLButtonElement>('[data-move-skip]')?.focus();
  }, [state?.phase, currentCollision?.name]);
  const picker = state?.phase === 'destination';
  const conflict = state?.phase === 'conflict';
  return {
    begin,
    dialog: (
      <Dialog
        open={Boolean(state)}
        title={
          conflict
            ? t('file.moveCollisionTitle', {
                count: 1,
                folder: state?.plan.destination.split('/').at(-1) || t('file.root'),
              })
            : t('file.move')
        }
        className={conflict ? 'fm-move-confirm fm-move-flow' : 'fm-move-flow'}
        closeIcon
        closeDisabled={busy}
        onClose={close}
      >
        <div ref={dialogBody}>
          {state && picker && (
            <>
              <FileSelectionSummary names={state.plan.names} />
              <FileDestinationTree
                serverId={options.serverId}
                source={state.plan.source}
                names={state.plan.names}
                value={state.plan.destination}
                onChange={(destination) =>
                  update({ ...state, plan: { ...state.plan, destination } })
                }
                disabled={busy}
              />
              <div className="fm-move-path">
                <span>{t('file.destination')}</span>
                <output aria-live="polite">/{state.plan.destination}</output>
              </div>
              <div className="actions fm-move-submit">
                <button
                  type="button"
                  disabled={
                    busy ||
                    !options.canMutate ||
                    !validMoveTarget(state.plan.source, state.plan.names, state.plan.destination)
                  }
                  onClick={() => void execute(state)}
                >
                  {t('file.move')}
                </button>
              </div>
            </>
          )}
          {conflict && currentCollision && (
            <>
              <p id={conflictNameId} className="fm-conflict-file" aria-live="polite">
                {currentCollision.name}
              </p>
              <p>
                {t(
                  currentCollision.canOverwrite
                    ? 'file.moveOverwriteWarning'
                    : 'file.moveCollisionUnsupported',
                )}
              </p>
              <div className="fm-conflict-actions">
                <button
                  type="button"
                  data-move-skip
                  aria-describedby={conflictNameId}
                  className="secondary"
                  disabled={busy}
                  onClick={() => decide('skip')}
                >
                  {t('file.skip')}
                </button>
                <button
                  type="button"
                  className="danger"
                  aria-describedby={conflictNameId}
                  disabled={busy || !currentCollision.canOverwrite}
                  onClick={() => decide('overwrite')}
                >
                  {t('file.overwrite')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => decide('skip', true)}
                  aria-describedby={conflictNameId}
                >
                  {t('file.skipAll')}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || !currentCollision.canOverwrite}
                  onClick={() => decide('overwrite', true)}
                  aria-describedby={conflictNameId}
                >
                  {t('file.overwriteAll')}
                </button>
              </div>
            </>
          )}
          {state?.phase === 'checking' && <p role="status">{t('web.pending')}</p>}
          {state?.phase === 'failed' && (
            <>
              <ErrorNotice error={state.error} />
              {state.attempted && <p>{t('file.moveInspectFailure')}</p>}
            </>
          )}
        </div>
      </Dialog>
    ),
  };
}
