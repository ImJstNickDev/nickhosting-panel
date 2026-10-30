import { createContext, type ReactNode, useContext, useEffect, useReducer, useRef } from 'react';
import { useBlocker } from 'react-router';
import { useT } from '../app/i18n.js';
import { ConfirmDialog } from './ui.js';

type Guard = { check(): boolean; pending(): boolean; custom: boolean };
type Blocker = ReturnType<typeof useBlocker>;
const Context = createContext<{
  guards: Map<symbol, Guard>;
  blocker: Blocker;
  changed(): void;
  custom: { current: boolean };
} | null>(null);

/** One router blocker for all forms and Files' specialized save/transfer flow. */
export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guards = useRef(new Map<symbol, Guard>()).current;
  const custom = useRef(false);
  const [, changed] = useReducer((version: number) => version + 1, 0);
  const t = useT();
  const blocker = useBlocker(() => {
    const dirty = [...guards.values()].filter((guard) => guard.check());
    custom.current = dirty.some((guard) => guard.custom);
    return dirty.length > 0;
  });
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (![...guards.values()].some((guard) => guard.check())) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [guards]);
  return (
    <Context.Provider value={{ guards, blocker, custom, changed }}>
      {children}
      <ConfirmDialog
        open={blocker.state === 'blocked' && !custom.current}
        title={t('web.unsavedChanges')}
        confirmLabel={t('web.discardChanges')}
        destructive
        busy={[...guards.values()].some((guard) => guard.pending())}
        onClose={() => {
          if (blocker.state === 'blocked') blocker.reset();
        }}
        onConfirm={async () => {
          if (blocker.state === 'blocked') blocker.proceed();
        }}
      >
        <p>{t('web.leaveUnsaved')}</p>
      </ConfirmDialog>
    </Context.Provider>
  );
}

export function useNavigationGuard(check: () => boolean, custom = false, pending = false): Blocker {
  const value = useContext(Context);
  if (!value) throw new Error('NavigationGuardProvider is required');
  const key = useRef(Symbol('draft')).current;
  const current = useRef(check);
  current.current = check;
  const currentPending = useRef(pending);
  useEffect(() => {
    value.guards.set(key, {
      check: () => current.current(),
      pending: () => currentPending.current,
      custom,
    });
    return () => {
      value.guards.delete(key);
    };
  }, [value.guards, key, custom]);
  useEffect(() => {
    currentPending.current = pending;
    value.changed();
  }, [value.changed, pending]);
  return value.blocker;
}

export function useUnsavedChanges(dirty: boolean, pending = false) {
  useNavigationGuard(() => dirty || pending, false, pending);
}
